import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { CohereEmbeddings } from "@langchain/cohere";
import { EmbeddingCache } from "../caching/embeddingCache.js";
import { hashString, makeChunkId, nowIso, countWords } from "./ragUtils.js";
import { prepareIngestionItems } from "./ingestionHelpers.js";
import { ConversationSummarizer } from "../utils/conversationSummarizer.js";

dotenv.config();


function getLanguageInstruction(language) {
    if (language === 'hindi') {
        return '\n\nIMPORTANT: You MUST respond ONLY in Hindi (Devanagari script: हिंदी). Use simple, clear Hindi language. Translate all technical terms to Hindi where possible, but you may keep English terms in parentheses for clarity when needed. The entire response should be in Hindi script, EVEN IF THE USER ASKS A QUESTION IN ANY OTHER LANGUAGE!';
    }
    return '\n\nIMPORTANT: You MUST respond ONLY in English. Use clear, professional English language, EVEN IF THE USER ASKS A QUESTION IN ANY OTHER LANGUAGE!';
}


class NITJSRRAGSystem {
    constructor(options = {}) {
        const { mongo = null } = options || {};
        this.genAI = null;
        this.pinecone = null;
        this.index = null;
        this.embeddings = null;
        this.chatModel = null;
        this.textSplitter = null;
        this.isInitialized = false;
        this.linkDatabase = new Map(); // Store links for easy retrieval
        this.embeddingCache = new EmbeddingCache();
        this.summarizer = null; // Will be initialized after chatModel is ready
        this.mongo = mongo;
        this.pagesColl = mongo?.pagesColl || null;
        this.chunksColl = mongo?.chunksColl || null;
        this._mongoIndexesEnsured = false;
        this._lastLedgerWarning = 0;
        try {
            const ec = this.embeddingCache.getStats();
            console.log(
                `[EmbeddingCache] initialized backend=${ec.backend} ttlSeconds=${ec.ttlSeconds} namespace=${ec.namespace}`
            );
        } catch (_) {}
    }

    refreshMongoHandles() {
        if (this.mongo?.pagesColl && this.mongo?.chunksColl) {
            this.pagesColl = this.mongo.pagesColl;
            this.chunksColl = this.mongo.chunksColl;
        }
    }


    mongoAvailable() {
        this.refreshMongoHandles();
        return Boolean(this.pagesColl && this.chunksColl);
    }


    async initialize() {
        if (this.isInitialized) return;

        console.log("Initializing Gemini(chat) + Cohere(emb) + Pinecone...");

        try {
            // Initialize Google Gemini
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.chatModel = this.genAI.getGenerativeModel({
                model: "gemini-2.0-flash",
            });

            // Initialize Pinecone
            this.pinecone = new Pinecone({
                apiKey: process.env.PINECONE_API_KEY.trim(),
            });

            // Get or create index
            await this.initializePineconeIndex();

            // Optional: verify index dimension to match Cohere embeddings (1024)
            try {
                const stats = await this.index.describeIndexStats();
                if (stats?.dimension && stats.dimension !== 1024) {
                    console.warn(
                        `Pinecone index '${process.env.PINECONE_INDEX_NAME.trim()}' has dimension ${
                            stats.dimension
                        }, but Cohere embeddings require 1024.`
                    );
                    console.warn(
                        "Please recreate the index with dimension 1024 to proceed."
                    );
                }
            } catch (e) {
                console.warn("Could not read Pinecone index stats:", e?.message || e);
            }

            // Initialize embeddings using Cohere
            this.embeddings = new CohereEmbeddings({
                apiKey: process.env.COHERE_API_KEY,
                model: process.env.COHERE_EMBED_MODEL || "embed-english-v3.0",
                inputType: "search_document",
            });

            this.textSplitter = new RecursiveCharacterTextSplitter({
                chunkSize: 1200,
                chunkOverlap: 300,
                separators: ["\n\n", "\n", ". ", "! ", "? ", " ", ""],
            });

            await this.ensureMongoIndexes();

            // Initialize conversation summarizer
            this.summarizer = new ConversationSummarizer(this.chatModel, {
                summaryThreshold: 12, // Summarize after 12 messages
                recentMessagesCount: 6 // Keep last 6 messages as-is
            });

            this.isInitialized = true;
            console.log("✅ Gemini RAG System initialized successfully!");
        } catch (error) {
            console.error("❌ RAG System initialization failed:", error.message);
            throw error;
        }
    }


    async initializePineconeIndex() {
        const indexName = process.env.PINECONE_INDEX_NAME.trim();

        try {
            // Check if index exists
            const indexList = await this.pinecone.listIndexes();
            const indexExists = indexList.indexes?.some(
                (index) => index.name === indexName
            );

            if (!indexExists) {
                console.log(`Creating new Pinecone index: ${indexName}`);
                await this.pinecone.createIndex({
                    name: indexName,
                    dimension: 1024,
                    metric: "cosine",
                    spec: {
                        serverless: {
                            cloud: "aws",
                            region: process.env.PINECONE_ENVIRONMENT.trim(),
                        },
                    },
                });

                console.log("Waiting for index to be ready...");
                await new Promise((resolve) => setTimeout(resolve, 60000));
            }

            this.index = this.pinecone.index(indexName);
            console.log(`Connected to Pinecone index: ${indexName}`);
        } catch (error) {
            console.error("Pinecone index initialization failed:", error.message);
            throw error;
        }
    }


    async ensureMongoIndexes() {
        if (!this.mongoAvailable()) {
            return;
        }
        if (this._mongoIndexesEnsured) {
            return;
        }
        try {
            await Promise.all([
                this.pagesColl.createIndex(
                    { url: 1 },
                    { unique: true, background: true }
                ),
                this.pagesColl.createIndex({ contentHash: 1 }, { background: true }),
                this.chunksColl.createIndex(
                    { chunkId: 1 },
                    { unique: true, background: true }
                ),
                this.chunksColl.createIndex({ url: 1 }, { background: true }),
                this.chunksColl.createIndex({ url: 1, index: 1 }, { background: true }),
            ]);
            this._mongoIndexesEnsured = true;
            console.log("[mongo] change ledger indexes ensured");
        } catch (error) {
            console.warn(
                "[mongo] failed to ensure indexes:",
                error?.message || error
            );
        }
    }


    buildLinkDatabase(scrapedData) {
        console.log("Building comprehensive link database...");

        if (scrapedData.links) {
            // PDF links
            scrapedData.links.pdf?.forEach((link) => {
                const key = `pdf_${link.text.toLowerCase().replace(/\s+/g, "_")}`;
                this.linkDatabase.set(key, {
                    type: "pdf",
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context,
                });

                const urlParts = link.url.split("/");
                const filename = urlParts[urlParts.length - 1].replace(".pdf", "");
                this.linkDatabase.set(
                    `pdf_${filename.toLowerCase()}`,
                    this.linkDatabase.get(key)
                );
            });

            // Internal page links
            scrapedData.links.internal?.forEach((link) => {
                const key = `page_${link.text.toLowerCase().replace(/\s+/g, "_")}`;
                this.linkDatabase.set(key, {
                    type: "page",
                    url: link.url,
                    text: link.text,
                    title: link.title,
                    sourceUrl: link.sourceUrl,
                    sourceTitle: link.sourceTitle,
                    context: link.context,
                });
            });
        }

        scrapedData.pages?.forEach((page) => {
            const key = `page_${page.title.toLowerCase().replace(/\s+/g, "_")}`;
            this.linkDatabase.set(key, {
                type: "page",
                url: page.url,
                text: page.title,
                title: page.title,
                category: page.category,
                wordCount: page.wordCount,
            });
        });

        scrapedData.documents?.pdfs?.forEach((pdf) => {
            const key = `pdf_${pdf.title.toLowerCase().replace(/\s+/g, "_")}`;
            this.linkDatabase.set(key, {
                type: "pdf_document",
                url: pdf.url,
                text: pdf.title,
                title: pdf.title,
                pages: pdf.pages,
                category: pdf.category,
                sourceUrl: pdf.parentPageUrl,
                sourceTitle: pdf.parentPageTitle,
                wordCount: pdf.wordCount,
            });
        });

        console.log(
            `Built link database with ${this.linkDatabase.size} entries`
        );
    }


    async _ingestWithLedger(scrapedData, options = {}) {
        const { preview = false } = options || {};

        if (!this.isInitialized) {
            await this.initialize();
        }

    this.buildLinkDatabase(scrapedData);

        if (!this.mongoAvailable()) {
            if (preview) {
                return {
                    preview: {
                        fallback: true,
                        reason: "MongoDB not connected",
                        counts: {
                            pages: { new: 0, modified: 0, unchanged: 0, deletedCandidate: 0 },
                            chunks: { toEmbed: 0, toDelete: 0 },
                        },
                    },
                };
            }

            if (Date.now() - this._lastLedgerWarning > 10000) {
                this._lastLedgerWarning = Date.now();
                console.warn(
                    "[mongo-ledger] MongoDB unavailable; skipping embedding because legacy path is disabled."
                );
            }

            return {
                success: false,
                ledger: true,
                reason: "MongoDB not connected, legacy embedding disabled",
            };
        }

        await this.ensureMongoIndexes();

        const runStartTimestamp = Date.now();
        const runStartedAt = nowIso();
        const ingestionItems = prepareIngestionItems(scrapedData);
        console.log(
            `[mongo-ledger] Starting ${
                preview ? "preview " : ""
            }ledger ingestion run at ${runStartedAt} with ${
                ingestionItems.length
            } source items.`
        );
        const seenUrls = new Set();
        const pagePlans = [];
        const stats = {
            pages: { new: 0, modified: 0, unchanged: 0, deletedCandidate: 0 },
            chunks: { toEmbed: 0, toDelete: 0 },
        };

        try {
            for (const item of ingestionItems) {
                const normalizedText = (item.structuredText || "").trim();
                if (!normalizedText) {
                    continue;
                }

                seenUrls.add(item.url);

                const wordCount = item.wordCount || countWords(normalizedText);
                const contentHash = hashString(normalizedText);
                const existingPage = await this.pagesColl.findOne(
                    { url: item.url },
                    {
                        projection: {
                            url: 1,
                            contentHash: 1,
                            chunkCount: 1,
                            version: 1,
                            deleted: 1,
                            lastEmbeddedAt: 1,
                        },
                    }
                );

                let status = "NEW";
                if (existingPage && existingPage.deleted) {
                    status = "NEW";
                } else if (existingPage) {
                    status =
                        existingPage.contentHash === contentHash ? "UNCHANGED" : "MODIFIED";
                }

                const statusKey = status.toLowerCase();
                if (typeof stats.pages[statusKey] === "number") {
                    stats.pages[statusKey] += 1;
                }

                if (status === "UNCHANGED") {
                    pagePlans.push({
                        url: item.url,
                        status,
                        type: item.type,
                        title: item.title,
                        category: item.category,
                        wordCount,
                        contentHash,
                        chunkCount: existingPage?.chunkCount || 0,
                        existingPage,
                    });
                    continue;
                }

                const splits = await this.textSplitter.splitText(normalizedText);
                const chunkCount = splits.length;

                let existingChunksArr = [];
                if (existingPage) {
                    existingChunksArr = await this.chunksColl
                        .find(
                            { url: item.url },
                            { projection: { chunkId: 1, textHash: 1 } }
                        )
                        .toArray();
                }

                const existingChunkMap = new Map(
                    existingChunksArr.map((doc) => [doc.chunkId, doc])
                );
                const currentChunkIds = new Set();
                const chunkInfos = [];

                for (let index = 0; index < splits.length; index++) {
                    const chunkText = splits[index];
                    const textHash = hashString(chunkText);
                    const chunkId = makeChunkId(item.url, index, textHash);
                    currentChunkIds.add(chunkId);

                    const existingChunk = existingChunkMap.get(chunkId);
                    if (existingChunk && existingChunk.textHash === textHash) {
                        continue;
                    }

                    const metadata = item.buildChunkMetadata(index, chunkCount);
                    chunkInfos.push({
                        chunkId,
                        url: item.url,
                        index,
                        text: chunkText,
                        textHash,
                        metadata,
                    });
                }

                const toDeleteIds = existingChunksArr
                    .filter((doc) => !currentChunkIds.has(doc.chunkId))
                    .map((doc) => doc.chunkId);

                stats.chunks.toEmbed += chunkInfos.length;
                stats.chunks.toDelete += toDeleteIds.length;

                pagePlans.push({
                    url: item.url,
                    status,
                    type: item.type,
                    title: item.title,
                    category: item.category,
                    wordCount,
                    contentHash,
                    chunkCount,
                    chunkInfos,
                    toDeleteIds,
                    existingPage,
                });
            }

            console.log(
                `[mongo-ledger] Page plan summary: new=${stats.pages.new}, modified=${stats.pages.modified}, unchanged=${stats.pages.unchanged}, toEmbed=${stats.chunks.toEmbed}, toDelete=${stats.chunks.toDelete}.`
            );

            const seenUrlsArray = Array.from(seenUrls);
            const staleUrls = [];
            stats.pages.deletedCandidate = 0;

            if (preview) {
                console.log(
                    "[mongo-ledger] Preview ledger ingestion complete (no writes performed)."
                );
                return {
                    preview: {
                        runStartedAt,
                        counts: stats,
                        seenUrls: seenUrls.size,
                        staleUrls,
                    },
                };
            }

            const chunksToEmbed = pagePlans.flatMap((plan) => plan.chunkInfos || []);
            const batchSize = 100;
            const totalBatches = Math.ceil(chunksToEmbed.length / batchSize);
            const embeddedUrls = new Set();
            const nowForChunks = nowIso();

            if (chunksToEmbed.length === 0) {
                console.log("[mongo-ledger] No chunks require embedding this run.");
            } else {
                console.log(
                    `[mongo-ledger] Embedding ${chunksToEmbed.length} chunks across ${totalBatches} batches (batchSize=${batchSize}).`
                );
            }

            for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
                const batch = chunksToEmbed.slice(i, i + batchSize);
                if (batch.length === 0) continue;

                const batchIndex = Math.floor(i / batchSize);
                console.log(
                    `[mongo-ledger] Upserting batch ${
                        batchIndex + 1
                    }/${totalBatches} (size=${batch.length}).`
                );

                const embeddings = await this.embeddings.embedDocuments(
                    batch.map((chunk) => chunk.text)
                );
                const vectors = batch.map((chunk, index) => ({
                    id: chunk.chunkId,
                    values: embeddings[index],
                    metadata: {
                        text: chunk.text.substring(0, 1000),
                        ...chunk.metadata,
                    },
                }));

                let upsertSucceeded = false;
                try {
                    await this.index.upsert(vectors);
                    upsertSucceeded = true;
                } catch (error) {
                    console.error(
                        "[mongo-ledger] Pinecone upsert failed:",
                        error?.message || error
                    );
                }

                if (upsertSucceeded) {
                    console.log(
                        `[mongo-ledger] Batch ${
                            batchIndex + 1
                        }/${totalBatches} stored successfully.`
                    );
                    const bulkOps = batch.map((chunk) => ({
                        updateOne: {
                            filter: { chunkId: chunk.chunkId },
                            update: {
                                $set: {
                                    url: chunk.url,
                                    index: chunk.index,
                                    textHash: chunk.textHash,
                                    pineconeId: chunk.chunkId,
                                    storedAt: nowForChunks,
                                    metadataSnapshot: {
                                        source: chunk.metadata.source,
                                        sourceType: chunk.metadata.sourceType,
                                        title: chunk.metadata.title,
                                        category: chunk.metadata.category,
                                        chunkIndex: chunk.metadata.chunkIndex,
                                        totalChunks: chunk.metadata.totalChunks,
                                    },
                                },
                            },
                            upsert: true,
                        },
                    }));

                    if (bulkOps.length) {
                        await this.chunksColl.bulkWrite(bulkOps, { ordered: false });
                    }
                    batch.forEach((chunk) => embeddedUrls.add(chunk.url));
                }
            }

            let deleteIds = pagePlans.flatMap((plan) => plan.toDeleteIds || []);
            deleteIds = [...new Set(deleteIds)];
            if (deleteIds.length === 0) {
                console.log("[mongo-ledger] No unique IDs to delete.");
            } else {
                console.log(
                    `[mongo-ledger] Deleting ${deleteIds.length} chunk vectors marked stale during ingestion.`
                );
                try {
                    const stats = await this.index.describeIndexStats();
                    const totalVectors = stats?.totalVectorCount || 0;
                    if (totalVectors === 0) {
                        console.log(
                            "[mongo-ledger] Skipping deletes: Pinecone index is empty or fresh."
                        );
                    } else {
                        const BATCH_SIZE = 500;
                        for (let i = 0; i < deleteIds.length; i += BATCH_SIZE) {
                            const batch = deleteIds.slice(i, i + BATCH_SIZE);
                            await this.index.deleteMany({ ids: batch });
                        }
                    }
                } catch (error) {
                    console.warn(
                        "[mongo-ledger] Pinecone delete failed:",
                        error?.message || error
                    );
                }
                try {
                    await this.chunksColl.deleteMany({ chunkId: { $in: deleteIds } });
                } catch (error) {
                    console.warn(
                        "[mongo-ledger] Mongo chunk delete failed:",
                        error?.message || error
                    );
                }
            }

            const pageUpdateTime = nowIso();
            for (const plan of pagePlans) {
                const versionBase = plan.existingPage?.version || 0;
                const removedChunks = (plan.toDeleteIds?.length || 0) > 0;
                const changedWithoutEmbed =
                    plan.status === "MODIFIED" &&
                    removedChunks &&
                    !embeddedUrls.has(plan.url);
                const shouldBumpVersion =
                    embeddedUrls.has(plan.url) ||
                    plan.status === "NEW" ||
                    changedWithoutEmbed;
                const updateDoc = {
                    url: plan.url,
                    type: plan.type,
                    title: plan.title,
                    category: plan.category,
                    wordCount: plan.wordCount,
                    contentHash: plan.contentHash,
                    chunkCount: plan.chunkCount ?? plan.existingPage?.chunkCount ?? 0,
                    lastSeenAt: runStartedAt,
                    deleted: false,
                    version: shouldBumpVersion ? versionBase + 1 : versionBase,
                };

                if (embeddedUrls.has(plan.url) || changedWithoutEmbed) {
                    updateDoc.lastEmbeddedAt = pageUpdateTime;
                } else if (plan.existingPage?.lastEmbeddedAt) {
                    updateDoc.lastEmbeddedAt = plan.existingPage.lastEmbeddedAt;
                }

                await this.pagesColl.updateOne(
                    { url: plan.url },
                    { $set: updateDoc },
                    { upsert: true }
                );
            }

            const durationMs = Date.now() - runStartTimestamp;
            console.log(
                `[mongo-ledger] Ledger ingestion completed in ${durationMs} ms. Pages seen=${seenUrls.size}, embedded=${embeddedUrls.size}, deletes=${stats.chunks.toDelete}.`
            );

            return {
                success: true,
                ledger: true,
                runStartedAt,
                stats,
            };
        } catch (error) {
            console.error("[mongo-ledger] ingestion error:", error?.message || error);
            if (preview) {
                throw error;
            }
            return {
                success: false,
                ledger: true,
                reason: "Mongo-ledger ingestion failed and legacy path is disabled",
                error: String(error?.message || error),
            };
        }
    }


    async processAndStoreDocuments(scrapedData, options = {}) {
        if (options?.preview) {
            return this.previewIngestion(scrapedData);
        }
        return this._ingestWithLedger(scrapedData, { preview: false });
    }


    async previewIngestion(scrapedData) {
        const result = await this._ingestWithLedger(scrapedData, { preview: true });
        return result.preview;
    }


    findRelevantLinks(question, documents) {
        const questionLower = question.toLowerCase();
        const relevantLinks = [];

        if (questionLower.includes("pdf") || questionLower.includes("document")) {
            for (const [key, link] of this.linkDatabase.entries()) {
                if (
                    key.startsWith("pdf_") &&
                    (link.text.toLowerCase().includes(questionLower) ||
                        questionLower.includes(link.text.toLowerCase()) ||
                        documents.some((doc) =>
                            doc.text.toLowerCase().includes(link.text.toLowerCase())
                        ))
                ) {
                    relevantLinks.push(link);
                }
            }
        }

        for (const [key, link] of this.linkDatabase.entries()) {
            if (
                (link.text.toLowerCase().includes(questionLower) ||
                    questionLower.includes(link.text.toLowerCase()) ||
                    (link.category && questionLower.includes(link.category))) &&
                relevantLinks.length < 5
            ) {
                relevantLinks.push(link);
            }
        }

        return relevantLinks;
    }


    async queryDocuments(question, topK = 8, precomputedEmbedding = null) {
        console.log(`🔍 Searching for: "${question}"`);

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const questionEmbedding =
                precomputedEmbedding ||
                (await this.embeddingCache.getQueryEmbedding(
                    question,
                    async (q) => await this.embeddings.embedQuery(q)
                ));
            try {
                const ecStats = this.embeddingCache.getStats();
                console.log(
                    `[EmbeddingCache] stats hits=${ecStats.hits} misses=${ecStats.misses} backend=${ecStats.backend}`
                );
            } catch (_) {}

            const searchResults = await this.index.query({
                vector: questionEmbedding,
                topK: topK,
                includeMetadata: true,
                includeValues: false,
            });

            const relevantDocuments =
                searchResults.matches?.map((match) => ({
                    text: match.metadata.text,
                    score: match.score,
                    metadata: match.metadata,
                })) || [];

            console.log(`Found ${relevantDocuments.length} relevant documents`);
            return relevantDocuments;
        } catch (error) {
            console.error("Error querying documents:", error.message);
            throw error;
        }
    }



    _filterAndDeduplicateSources(sources, minScore = 0.40) {
        if (!Array.isArray(sources) || sources.length === 0) {
            return [];
        }

        const relevantSources = sources.filter(source => {
            const score = source.score || 0;
            return score >= minScore;
        });

        console.log(`[SourceFilter] Filtered ${sources.length} → ${relevantSources.length} sources (min score: ${minScore})`);

        if (relevantSources.length === 0) {
            return [];
        }

        const seenUrls = new Set();
        const deduplicated = [];

        for (const source of relevantSources) {
            const url = source.url || '';
            if (!url || !seenUrls.has(url)) {
                if (url) seenUrls.add(url);
                deduplicated.push(source);
            } else {
                console.log(`[SourceFilter] Skipped duplicate URL: ${url}`);
            }
        }

        console.log(`[SourceFilter] Removed ${relevantSources.length - deduplicated.length} duplicate sources`);
        deduplicated.sort((a, b) => (b.score || 0) - (a.score || 0));
        return deduplicated;
    }



    async chatStream(
        question,
        precomputedEmbedding = null,
        onChunk = null,
        history = [],
        language = "english",
        userContext = null,
        conversationSummary = null,
        chatHistoryManager = null
    ) {
        try {
            const questionEmbedding =
                precomputedEmbedding ||
                (await this.embeddingCache.getQueryEmbedding(
                    question,
                    async (q) => await this.embeddings.embedQuery(q)
                ));

            try {
                const ecStats = this.embeddingCache.getStats();
                console.log(
                    `[EmbeddingCache] stats hits=${ecStats.hits} misses=${ecStats.misses} backend=${ecStats.backend}`
                );
            } catch (_) {}

            const relevantDocs = await this.queryDocuments(question, 8, questionEmbedding);

            if (relevantDocs.length === 0) {
                const fallback =
                    language === "hindi"
                        ? "मेरे पास उस विषय के बारे में विशिष्ट जानकारी नहीं है। क्या आप कृपया अपना प्रश्न दोबारा बता सकते हैं या प्लेसमेंट, शिक्षाविदों, संकाय, विभागों या अन्य कॉलेज से संबंधित विषयों के बारे में पूछ सकते हैं?"
                        : "I don't have specific information about that topic in the NIT Jamshedpur data. Could you please rephrase your question or ask about placements, academics, faculty, departments, or other college-related topics?";

                if (typeof onChunk === "function") {
                    try {
                        onChunk(fallback);
                    } catch (_) {}
                }

                return {
                    answer: fallback,
                    sources: [],
                    relevantLinks: [],
                    confidence: 0,
                    language,
                };
            }

            // Gather links and build context
            const relevantLinks = this.findRelevantLinks(question, relevantDocs);
            const context = relevantDocs.map((doc, index) => {
                const sourceInfo =
                    doc.metadata.sourceType === "pdf_document"
                        ? `[PDF Document ${index + 1}: ${doc.metadata.title} (${doc.metadata.pages} pages)]`
                        : `[Page ${index + 1}: ${doc.metadata.title}]`;

                return `${sourceInfo} ${doc.text}`;
              }).join("\n\n");


            const linksContext =
                relevantLinks.length > 0 ? `Relevant Links Available:
                ${relevantLinks.map((link) => `• ${link.text}: ${link.url} ${link.type === "pdf" ? "(PDF Document)" : "(Web Page)"}`).join("\n")}` : "";

            const languageInstruction = getLanguageInstruction(language);

            // Process conversation history with summarization if needed
            let processedHistory = history;
            let summaryText = conversationSummary;

            if (this.summarizer && this.summarizer.needsSummarization(history)) {
                const result = await this.summarizer.processHistory(history, language, conversationSummary);
                processedHistory = result.recent;
                summaryText = result.summary;

                // Save updated summary if available
                if (result.shouldUpdate && summaryText && chatHistoryManager) {
                    try {
                        const sessionId = chatHistoryManager.currentSessionId;
                        if (sessionId) {
                            await chatHistoryManager.setSummary(sessionId, summaryText);
                            console.log(`[Summarizer] Saved updated summary for session`);
                        }
                    } catch (err) {
                        console.warn('[Summarizer] Failed to save summary:', err.message);
                    }
                }
            }

            const formatConversationHistory = (recentMessages) => {
                if (!Array.isArray(recentMessages) || recentMessages.length === 0) return "";
                const formatted = recentMessages
                    .map((msg) => {
                        const role = msg.role === "user" ? "User" : "Assistant";
                        return `${role}: ${String(msg.content || "").trim()}`;
                    })
                    .join("\n");
                return formatted ? `\n\nRecent Conversation:\n${formatted}\n` : "";
            };

            const summarySection = summaryText ? `\n\nConversation Summary (Long-term Context):\n${summaryText}\n` : "";
            const historySection = formatConversationHistory(processedHistory);

            const buildUserContextSection = (userContext) => {
                if (!userContext) return "";
                const parts = [];
                if (userContext.role) parts.push(`Role: ${userContext.role}`);
                if (userContext.department) parts.push(`Department: ${userContext.department}`);
                if (userContext.year) parts.push(`Year: ${userContext.year}`);
                if (parts.length === 0) return "";
                return `\n\nUser Metadata:\n${parts.join('\n')}\n`;
            };

            const userContextSection = buildUserContextSection(userContext);

            const prompt = `
            You are an AI assistant specializing in NIT Jamshedpur information. Your role is to provide accurate, helpful, and contextually aware responses based on the provided data and conversation history.
            ${languageInstruction}

            ${summarySection ? summarySection : ""}
            ${historySection ? historySection : ""}
            ${userContextSection ? userContextSection : ""}

            Knowledge Base Context:
            ${context || "No relevant context found."}
            ${linksContext}

            Current Question: ${question}
            ${languageInstruction}

            Instructions:

            Context Awareness:
            - The Conversation Summary contains key facts from earlier in the conversation (long-term memory).
            - The Recent Conversation shows the most recent exchanges (short-term memory).
            - Use BOTH to understand the full context of the conversation.
            - If the question references previous messages (e.g., "tell me more", "what about that", "its placement"), check both summary and recent conversation.
            - Maintain consistency with earlier responses in this conversation.
            - Resolve pronouns like "it", "that", "this" using context from summary and recent messages.

            Answer Guidelines:
            - Base your answer primarily on the context from the database.
            - Use user context (department, year, role) to provide more relevant answers.
            - Provide specific data points (placement %, packages, companies, year, etc.) when available.
            - If context lacks information, clearly state that.
            - Be concise, professional, and structured.
            - When relevant links are available, mention them naturally.
            - For PDFs, say: "Refer to [Document Name] (PDF): [URL]"
            - For web pages, say: "See [Page Title]: [URL]"

            Formatting:
            - Use clear paragraphs.
            - Bold key points with **text**.
            - Use bullet points when appropriate.
            - Keep tone informative yet conversational.

            Follow-up Handling:
            - If user asks "tell me more" or similar, expand on the most recent topic.
            - If unsure what pronoun refers to, ask for clarification.

            Answer:
            `;

            console.log("===================PROMPT==================:", prompt);

            console.log(
              `[Chat] Processing ${history.length} messages | Language: ${language}`
            );

            const streamResult = await this.chatModel.generateContentStream(prompt);
            let fullText = "";

            if (streamResult?.stream) {
                for await (const chunk of streamResult.stream) {
                    const part =
                        typeof chunk?.text === "function" ? chunk.text() : chunk?.text;
                    if (part) {
                        fullText += part;
                        if (typeof onChunk === "function") {
                            try {
                                onChunk(part);
                            } catch (_) {}
                        }
                    }
                }
            }

            if (!fullText && streamResult?.response) {
                try {
                    fullText = (await streamResult.response).text() || "";
                } catch (_) {}
            }

            const enhancedSources = relevantDocs.map((doc) => ({
                text: doc.text.substring(0, 200) + "...",
                source: doc.metadata.source,
                sourceType: doc.metadata.sourceType,
                url: doc.metadata.url,
                title: doc.metadata.title,
                score: doc.score,
                pages: doc.metadata.pages,
                category: doc.metadata.category,
            }));

            relevantLinks.forEach((link) => {enhancedSources.push({
                text: link.context || link.text,
                source: link.type,
                sourceType: "link",
                url: link.url,
                title: link.text,
                score: 0.8,
                category: "link",});
            });

            const filteredSources = this._filterAndDeduplicateSources(
                enhancedSources,
                0.5
            );

            return {
                answer: fullText,
                sources: filteredSources,
                relevantLinks,
                confidence: relevantDocs.length > 0 ? relevantDocs[0].score : 0,
                language,
            };
        }
        catch (error) {
            console.error("Chat stream error:", error.message);
            throw error;
        }
    }


    async getIndexStats() {
        try {
            const stats = await this.index.describeIndexStats({});

            const totalFromNamespaces = Object.values(stats?.namespaces ?? {}).reduce(
                (sum, ns) => sum + (ns?.vectorCount ?? 0),
                0
            );

            const totalVectors =
                typeof stats?.totalRecordCount === "number"
                    ? stats.totalRecordCount
                    : totalFromNamespaces;

            return {
                totalVectors,
                dimension: stats?.dimension ?? 1024,
                indexFullness: stats?.indexFullness ?? 0,
                linkDatabaseSize: this.linkDatabase?.size ?? 0,
            };
        } catch (error) {
            console.error("❌ Error getting index stats:", error.message || error);
            return { totalVectors: 0, error: String(error?.message || error) };
        }
    }


  async clearIndex() {
        console.log("Clearing Pinecone index and link database...");
        try {
            await this.index.deleteAll();
            this.linkDatabase.clear();
            console.log("Index and link database cleared successfully");
        } catch (error) {
            console.error("Error clearing index:", error.message);
            throw error;
        }
    }

}


export { NITJSRRAGSystem };
