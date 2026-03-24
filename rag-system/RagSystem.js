import dotenv from "dotenv";
import { CohereClient } from "cohere-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { CohereEmbeddings } from "@langchain/cohere";
import { EmbeddingCache } from "../caching/embeddingCache.js";
import { hashString, makeChunkId, nowIso, countWords } from "./ragUtils.js";
import { prepareIngestionItems } from "./ingestionHelpers.js";
import { ConversationSummarizer } from "../utils/conversationSummarizer.js";

dotenv.config();


class JharkhandGovRAGSystem {
    constructor(options = {}) {
        const { mongo = null } = options || {};
        this.cohere = null;
        this.pinecone = null;
        this.index = null;
        this.embeddings = null;
        this.chatModelName = process.env.COHERE_CHAT_MODEL || "command-r-plus";
        this.textSplitter = null;
        this.isInitialized = false;
        this.linkDatabase = new Map(); // Store links for easy retrieval
        this.embeddingCache = new EmbeddingCache();
        this.summarizer = null; // Will be initialized after Cohere client is ready
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

    async classifyQuery(question, language = "english") {
        const classificationPrompt = language === "hindi"
            ? `आप एक AI सहायक हैं जो GSCC योजना से संबंधित प्रश्नों को वर्गीकृत (classify) करता है।

**निर्देश:**
1. वर्तनी (spelling) और व्याकरण की गलतियों को पूरी तरह नज़रअंदाज़ करें।
2. उत्तर में केवल श्रेणी का नाम (Category Name) लिखें, और कुछ भी नहीं।

**श्रेणियां (Categories):**
- GSCC_SPECIFIC:FACT_LIST -> दस्तावेज़, पात्रता (eligibility), या समय-सीमा की सूची।
- GSCC_SPECIFIC:FACT_VALUE -> कोई एक निश्चित संख्या या जानकारी (ब्याज दर, अधिकतम लोन, आयु सीमा)।
- GSCC_SPECIFIC:PROCEDURE -> काम करने का तरीका या स्टेप-बाय-स्टेप गाइड (आवेदन कैसे करें)।
- GSCC_SPECIFIC:EXPLANATION -> योजना के बारे में विस्तार से जानकारी या "क्यों" वाले प्रश्न।
- GREETING -> नमस्ते, हाय, धन्यवाद।
- FOLLOWUP -> पिछले सवाल से जुड़ा छोटा सवाल (जैसे: "और क्या?", "इसके बाद क्या करें?")।

**उदाहरण (Examples):**
- "जरूरी कागज कौन से हैं?" -> GSCC_SPECIFIC:FACT_LIST
- "ब्याज कितना लगेगा?" -> GSCC_SPECIFIC:FACT_VALUE
- "फॉर्म कैसे भरना है?" -> GSCC_SPECIFIC:PROCEDURE
- "GSCC स्कीम क्या है और इसके फायदे क्या हैं?" -> GSCC_SPECIFIC:EXPLANATION
- "नमस्ते" -> GREETING

प्रश्न: "${question}"
श्रेणी:`
            : `Analyze this query for the GSCC scheme classification. Be extremely lenient with spelling and typos.

**Categories:**
- GSCC_SPECIFIC:FACT_LIST (Lists like docs, eligibility criteria, slabs)
- GSCC_SPECIFIC:FACT_VALUE (Single values like max loan, interest rate, age limit)
- GSCC_SPECIFIC:PROCEDURE (Step-by-step "how-to" processes)
- GSCC_SPECIFIC:EXPLANATION (Conceptual questions, "why", "how it works")
- GREETING (Hi, hello, thanks)
- FOLLOWUP (Contextual continuation like "anything else?")

**Examples:**
- "What docs are needed?" -> GSCC_SPECIFIC:FACT_LIST
- "What's the max limit?" -> GSCC_SPECIFIC:FACT_VALUE
- "How do I apply?" -> GSCC_SPECIFIC:PROCEDURE
- "Explain the scheme" -> GSCC_SPECIFIC:EXPLANATION

Return ONLY the category name.

QUERY: "${question}"
CATEGORY:`;


        try {
            const response = await this.cohere.chat({
                model: this.chatModelName,
                message: classificationPrompt,
                temperature: 0.1,
                maxTokens: 10
            });

            const category = response.text.trim().toUpperCase();

            // Map to standardized categories
            if (category.includes('GSCC') || category.includes('SPECIFIC')) return 'GSCC_SPECIFIC';
            if (category.includes('GREETING')) return 'GREETING';
            // if (category.includes('VAGUE')) return 'VAGUE';
            if (category.includes('OFF_TOPIC') || category.includes('TOPIC')) return 'OFF_TOPIC';
            if (category.includes('FOLLOWUP') || category.includes('FOLLOW')) return 'FOLLOWUP';

            return 'GSCC_SPECIFIC'; // Default to specific if unclear
        } catch (error) {
            console.error('[Query Classification Error]:', error);
            return 'GSCC_SPECIFIC'; // Fail open
        }
    }


    async handleGreeting(language) {
        return language === "hindi"
            ? "नमस्ते! मैं GSCC योजना विशेषज्ञ हूँ। मैं पात्रता, ऋण राशि, ब्याज दर, आवेदन प्रक्रिया या दस्तावेज़ों के बारे में बता सकता हूँ। आप क्या जानना चाहेंगे?"
            : "Hello! I'm the GSCC Scheme expert. I can explain eligibility, loan amounts, interest rates, application process, or required documents. What would you like to know?";
    }


    async handleOffTopic(language) {
        return language === "hindi"
            ? "मैं केवल झारखंड सरकार की गुरुजी स्टूडेंट क्रेडिट कार्ड (GSCC) योजना के बारे में सहायता कर सकता हूँ। कृपया योजना के बारे में प्रश्न पूछें।"
            : "I can only help with the Jharkhand Government's Guruji Student Credit Card (GSCC) Scheme. Please ask questions related to the scheme.";
    }


    isContextRelevant(relevantDocs, minScore = 0.4, minDocs = 1) {
        if (!relevantDocs || relevantDocs.length === 0) return false;

        const highQualityDocs = relevantDocs.filter(doc => {
            console.log("SCORE:", doc.score);
            return doc.score >= minScore;
        });

        if (highQualityDocs.length < minDocs) {
            console.log(`[Context Check] Only ${highQualityDocs.length} relevant docs found (need ${minDocs})`);
            return false;
        }

        return true;
    }


//     buildFocusedPrompt(question, context, history, language) {
//         const languageInstruction = language === 'hindi'
//             ? '\n\nIMPORTANT: केवल हिंदी में जवाब दें। सरल और स्पष्ट भाषा का उपयोग करें।'
//             : '\n\nIMPORTANT: Respond ONLY in English. Use clear, professional language.';
//
//         const historySection = this.formatConversationHistory(history);
//
//         return `You are an AI assistant for the Jharkhand GSCC Scheme.
//
// ${languageInstruction}
//
//
// ### RULES:
// 1. Answer ONLY using the provided context below
// 2. Be VERY lenient with spelling mistakes - understand the intent even if words are misspelled
// 3. Be concise - maximum 3 short paragraphs
// 4. NEVER include document citations like "[PDF Document X: ...]" in your answer
// 5. If the context doesn't contain the answer, say: "I don't have that specific information"
// 6. Use bullet points ONLY for listing items (maximum 5-7 items)
// 7. No greetings, no closings - just answer directly
//
// ${historySection ? '### PREVIOUS CONVERSATION:\n' + historySection + '\n' : ''}
//
// ### CONTEXT:
// ${context}
//
// ### QUESTION:
// ${question}
//
// Provide a direct, helpful answer based ONLY on the context above:`;
//     }


    buildFocusedPrompt(question, context, history, language, userContext = null, conversationSummary = null) {
        const languageConfig = {
            hindi: {
                instruction: 'IMPORTANT: केवल हिंदी में जवाब दें (Natural Hinglish)। "Interest Rate", "Loan" जैसे शब्दों का अंग्रेजी में उपयोग करें।',
                rules: `
                1. केवल नीचे दिए गए "CONTEXT" के आधार पर उत्तर दें।
                2. वर्तनी की गलतियों को नजरअंदाज करें।
                3. उत्तर संक्षिप्त रखें - अधिकतम 3 छोटे पैराग्राफ।
                4. [PDF Document X] जैसे साइटेशन न लिखें।
                5. यदि जवाब नहीं है, तो कहें: "क्षमा करें, मेरे पास यह जानकारी नहीं है।"
                6. लिस्ट के लिए बुलेट पॉइंट्स का उपयोग करें (अधिकतम 5-7 आइटम)।
                7. कोई Greeting या Closing न लिखें।
                8. जानकारी को दोहराएं नहीं। यदि CONTEXT में एक ही बात बार-बार लिखी है, तो उसे उत्तर में केवल एक बार ही लिखें।
            `,
                contextInstruction: 'Conversation Summary में पुरानी बातचीत के मुख्य बिंदु हैं और Recent Conversation में हाल की बातचीत है। दोनों का उपयोग करके संदर्भ समझें।',
                fallback: 'Provide a direct answer in Hindi based ONLY on the context:'
            },
            english: {
                instruction: 'IMPORTANT: Respond ONLY in English.',
                rules: `
                1. Answer ONLY using the provided context.
                2. Be lenient with spelling mistakes.
                3. Be concise - maximum 3 short paragraphs.
                4. NEVER include document citations like "[PDF Document X]".
                5. If information is missing, say: "I don't have that specific information."
                6. Use bullet points for lists (max 5-7 items).
                7. No greetings or closings.
                8. DO NOT REPEAT information. If the context contains redundant points, consolidate them into one single clear bullet point.
            `,
                contextInstruction: 'The Conversation Summary contains key facts from earlier conversation (long-term memory) and Recent Conversation shows recent exchanges (short-term memory). Use BOTH to understand full context.',
                fallback: 'Provide a direct answer based ONLY on the context:'
            }
        };

        const config = language === 'hindi' ? languageConfig.hindi : languageConfig.english;

        // Build conversation sections
        const summarySection = conversationSummary ? `\n### CONVERSATION SUMMARY (Long-term Context):\n${conversationSummary}\n` : '';
        const historySection = this.formatConversationHistory(history);
        const recentSection = historySection ? `\n### RECENT CONVERSATION (Short-term Context):\n${historySection}\n` : '';

        // Build user context section
        const buildUserContextSection = (ctx) => {
            if (!ctx) return '';
            const parts = [];
            if (ctx.role) parts.push(`Role: ${ctx.role}`);
            if (ctx.department) parts.push(`Department: ${ctx.department}`);
            if (ctx.year) parts.push(`Year: ${ctx.year}`);
            if (parts.length === 0) return '';
            return `\n### USER METADATA:\n${parts.join('\n')}\n`;
        };
        const userContextSection = buildUserContextSection(userContext);

        const contextAwarenessNote = (summarySection || recentSection) ? `\n### CONTEXT AWARENESS:\n${config.contextInstruction}\n` : '';

        return `You are an AI assistant for the NIT Jamshedpur (NITJSR) information system.

${config.instruction}

### RULES:
${config.rules}
${contextAwarenessNote}${summarySection}${recentSection}${userContextSection}
### KNOWLEDGE BASE CONTEXT:
${context}

### CURRENT QUESTION:
${question}

${config.fallback}`;
    }


    formatConversationHistory(history, maxTurns = 3) {
        if (!Array.isArray(history) || history.length === 0) return "";
        const recent = history.slice(-maxTurns * 2);
        return recent
            .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
            .join('\n');
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

        console.log("Initializing Cohere(chat) + Cohere(emb) + Pinecone...");

        try {
            // Initialize Cohere Client
            this.cohere = new CohereClient({
                token: process.env.COHERE_API_KEY,
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

            // Initialize conversation summarizer
            this.summarizer = new ConversationSummarizer(this.cohere, this.chatModelName, {
                summaryThreshold: 12,
                recentMessagesCount: 6
            });

            await this.ensureMongoIndexes();
            this.isInitialized = true;
            console.log("✅ Cohere RAG System initialized successfully!");
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

        //TODO: This is local pdf url in my computer, may need change during deployment
        seenUrls.add("local://guruji_guidelines.pdf");
        seenUrls.add("local://676_2_2024.pdf");

        const deduplicated = [];

        for (const source of relevantSources) {
            const url = source.url || '';
            if (!url || !seenUrls.has(url) ) {
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
            // Step 1: Classify the query
            const queryType = await this.classifyQuery(question, language);
            console.log(`[Query Type]: ${queryType}`);

            let response = '';

            // Step 2: Handle based on classification
            switch (queryType) {
                case 'GREETING':
                    response = await this.handleGreeting(language);
                    if (typeof onChunk === "function") {
                        onChunk(response);
                    }
                    return {
                        answer: response,
                        sources: [],
                        relevantLinks: [],
                        confidence: 1.0,
                        language,
                    };

                // case 'VAGUE':
                //     response = await this.handleVagueQuery(question, language);
                //     if (typeof onChunk === "function") {
                //         onChunk(response);
                //     }
                //     return {
                //         answer: response,
                //         sources: [],
                //         relevantLinks: [],
                //         confidence: 0.3,
                //         language,
                //     };

                case 'OFF_TOPIC':
                    response = await this.handleOffTopic(language);
                    if (typeof onChunk === "function") {
                        onChunk(response);
                    }
                    return {
                        answer: response,
                        sources: [],
                        relevantLinks: [],
                        confidence: 0.8,
                        language,
                    };

                case 'FOLLOWUP':
                case 'GSCC_SPECIFIC':
                default:
                    // Continue to RAG pipeline below
                    break;
            }

            // Step 3: Get embeddings for RAG
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

            // Step 4: Retrieve relevant documents
            const relevantDocs = await this.queryDocuments(question, 5, questionEmbedding);

            // Step 5: Check if context is relevant enough
            // if (!this.isContextRelevant(relevantDocs, 0.4, 1)) {
            //     const fallbackResponse = language === "hindi"
            //         ? "मेरे पास इस प्रश्न के लिए आधिकारिक जानकारी उपलब्ध नहीं है।"
            //         : "I don't have verified information to answer this question.";
            //
            //     if (onChunk) onChunk(fallbackResponse);
            //
            //     return {
            //         answer: fallbackResponse,
            //         sources: [],
            //         relevantLinks: [],
            //         confidence: 0.2,
            //         language,
            //     };
            // }

            // Step 6: Process conversation history with summarization if needed
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

            // Step 7: Build clean context (NO document listings in context)
            const context = relevantDocs
                .slice(0, 5)
                .map(doc => doc.text)
                .join("\n\n");

            // Step 8: Build focused prompt with conversation summary and user context
            const prompt = this.buildFocusedPrompt(question, context, processedHistory, language, userContext, summaryText);

            console.log("===================PROMPT==================:");
            console.log(prompt);
            console.log("===========================================");

            console.log(
                `[Chat] Processing ${history.length} messages | Language: ${language}`
            );

            // Step 8: Stream response from LLM
            const messages = [
                {
                    role: "user",
                    content: prompt,
                },
            ];

            const stream = await this.cohere.v2.chatStream({
                model: this.chatModelName,
                messages: messages,
            });

            let fullText = "";

            for await (const chunk of stream) {
                if (chunk.type === "content-delta") {
                    const part = chunk.delta?.message?.content?.text;
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

            // Step 9: Prepare sources for response
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

            const filteredSources = this._filterAndDeduplicateSources(
                enhancedSources,
                0.5
            );

            return {
                answer: fullText,
                sources: filteredSources,
                relevantLinks: [],
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
        if (!this.isInitialized) {
            await this.initialize();
        }

        console.log("Clearing Pinecone index and link database...");
        try {
            // deleteAll() can throw 404 on some serverless index states if already empty
            await this.index.deleteAll().catch(err => {
                if (err.message?.includes('404')) {
                    console.log("[pinecone] Index already appears to be empty (received 404).");
                } else {
                    throw err;
                }
            });
            
            this.linkDatabase.clear();

            // Also clear MongoDB ledger if possible
            if (this.mongoAvailable()) {
                console.log("[mongo] Clearing change ledger collections...");
                await Promise.all([
                    this.pagesColl.deleteMany({}),
                    this.chunksColl.deleteMany({})
                ]);
            }

            console.log("Index and link database cleared successfully");
        } catch (error) {
            console.error("Error clearing index:", error.message);
            throw error;
        }
    }

}


export { JharkhandGovRAGSystem, JharkhandGovRAGSystem as NITJSRRAGSystem };
