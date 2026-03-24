import { authenticateAdmin } from "../config/auth.js";

export function setupHealthRoutes(app, server) {

    // Health check endpoint
    app.get('/health', async (req, res) => {
        try {
            const indexStats = await server.ragSystem.getIndexStats();
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                initialized: server.isInitialized,
                vectorDatabase: indexStats,
                embeddingCache: server.ragSystem?.embeddingCache?.getStats?.() || null,
                responseCache: server.responseCache?.getStats?.() || null,
                mongo: {
                    status: server.dbManager.mongo.status,
                    db: server.dbManager.mongo.dbName,
                    pagesCollection: server.dbManager.mongo.pagesName,
                    chunksCollection: server.dbManager.mongo.chunksName,
                    lastError: server.dbManager.mongo.lastError,
                },
                environment: process.env.NODE_ENV || 'development',
                aiProvider: 'Cohere',
                chatModel: process.env.COHERE_CHAT_MODEL || 'command-r-plus',
                pineconeIndex: process.env.PINECONE_INDEX_NAME?.trim() || 'Not configured',
            });
        } catch (error) {
            res.status(500).json({ status: 'unhealthy', error: error.message });
        }
    });



    // Test Cohere connection
    app.get('/test-cohere', authenticateAdmin, async (req, res) => {
        try {
            const { CohereClient } = await import('cohere-ai');
            const cohere = new CohereClient({
                token: process.env.COHERE_API_KEY,
            });

            const result = await cohere.chat({
                model: process.env.COHERE_CHAT_MODEL || 'command-r-plus',
                message: 'Say hello and confirm you are working correctly.',
            });

            res.json({
                success: true,
                message: 'Cohere connection successful',
                response: result.text,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            res
                .status(500)
                .json({ success: false, error: 'Cohere connection failed: ' + error.message });
        }
    });



    // Test Pinecone connection
    app.get('/test-pinecone', authenticateAdmin, async (req, res) => {
        try {
            const { Pinecone } = await import('@pinecone-database/pinecone');
            const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY.trim() });

            const indexList = await pinecone.listIndexes();
            const targetIndex = process.env.PINECONE_INDEX_NAME?.trim();
            const indexExists = indexList.indexes?.some((index) => index.name === targetIndex);

            res.json({
                success: true,
                message: 'Pinecone connection successful',
                targetIndex: targetIndex,
                indexExists: indexExists,
                availableIndexes: indexList.indexes?.map((i) => i.name) || [],
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            res
                .status(500)
                .json({ success: false, error: 'Pinecone connection failed: ' + error.message });
        }
    });
}