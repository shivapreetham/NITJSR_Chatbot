// Conversation Summarizer - Long-Short Term Memory System
// Summarizes long conversations to maintain context without overwhelming the LLM

export class ConversationSummarizer {
    constructor(cohereClient, chatModelName, options = {}) {
        this.cohereClient = cohereClient;
        this.chatModelName = chatModelName;
        this.summaryThreshold = options.summaryThreshold || 12; // Summarize after 12 messages (6 turns)
        this.recentMessagesCount = options.recentMessagesCount || 6; // Keep last 6 messages as-is
    }

    /**
     * Determines if conversation needs summarization
     */
    needsSummarization(history) {
        return history.length >= this.summaryThreshold;
    }

    /**
     * Extracts key facts from conversation history using LLM
     * Returns a concise summary of important information
     */
    async generateSummary(messages, language = 'english', currentSummary = null) {
        if (!messages || messages.length === 0) {
            return null;
        }

        const conversationText = messages
            .map((msg) => {
                const role = msg.role === 'user' ? 'User' : 'Assistant';
                return `${role}: ${msg.content}`;
            })
            .join('\n');

        const languageInstruction = language === 'hindi'
            ? 'Respond in Hindi (Devanagari script).'
            : 'Respond in English.';

        const existingSummarySection = currentSummary
            ? `\n\nPrevious Summary:\n${currentSummary}\n`
            : '';

        const prompt = `You are a conversation summarizer. Extract ONLY the key facts and context from this conversation.

${existingSummarySection}
Conversation to Summarize:
${conversationText}

Instructions:
1. Extract ONLY factual information about the user (department, year, interests, preferences)
2. Note key topics discussed and important questions asked
3. Keep it concise - maximum 5-6 bullet points
4. DO NOT include greetings, pleasantries, or generic responses
5. Focus on persistent context that helps answer future questions
6. ${languageInstruction}

Format as bullet points. If previous summary exists, merge and deduplicate information.

Summary:`;

        try {
            const response = await this.cohereClient.chat({
                model: this.chatModelName,
                message: prompt,
                temperature: 0.3,
            });

            const summary = response.text.trim();

            console.log(`[Summarizer] Generated summary (${summary.length} chars) from ${messages.length} messages`);
            return summary;
        } catch (error) {
            console.error('[Summarizer] Failed to generate summary:', error.message);
            return currentSummary; // Return existing summary on failure
        }
    }

    /**
     * Splits conversation into:
     * - summary: Compressed summary of older messages
     * - recent: Recent messages kept as-is for immediate context
     */
    async processHistory(history, language = 'english', existingSummary = null) {
        if (!this.needsSummarization(history)) {
            return {
                summary: existingSummary,
                recent: history,
                shouldUpdate: false
            };
        }

        // Split: older messages to summarize, recent messages to keep
        const splitPoint = history.length - this.recentMessagesCount;
        const olderMessages = history.slice(0, splitPoint);
        const recentMessages = history.slice(splitPoint);

        console.log(`[Summarizer] Processing: ${history.length} total -> ${olderMessages.length} to summarize, ${recentMessages.length} recent`);

        // Generate summary of older messages
        const newSummary = await this.generateSummary(olderMessages, language, existingSummary);

        return {
            summary: newSummary,
            recent: recentMessages,
            shouldUpdate: true
        };
    }

    /**
     * Formats the processed conversation for the prompt
     */
    formatForPrompt(summary, recentMessages) {
        let formatted = '';

        if (summary) {
            formatted += `\n\nConversation Summary (Long-term Context):\n${summary}\n`;
        }

        if (recentMessages && recentMessages.length > 0) {
            const recentText = recentMessages
                .map((msg) => {
                    const role = msg.role === 'user' ? 'User' : 'Assistant';
                    return `${role}: ${msg.content}`;
                })
                .join('\n');
            formatted += `\n\nRecent Conversation (Short-term Context):\n${recentText}\n`;
        }

        return formatted;
    }

    /**
     * Extract user context from summary and recent messages
     * This is a fallback/enhancement to the context extractor
     */
    extractContextFromSummary(summary) {
        if (!summary) return null;

        const context = {};
        const lowerSummary = summary.toLowerCase();

        // Extract department mentions
        const deptPatterns = [
            { pattern: /computer science|cs|cse/i, dept: 'Computer Science and Engineering' },
            { pattern: /mechanical|mech/i, dept: 'Mechanical Engineering' },
            { pattern: /electrical|ee/i, dept: 'Electrical Engineering' },
            { pattern: /civil/i, dept: 'Civil Engineering' },
            { pattern: /electronics|ece/i, dept: 'Electronics and Communication Engineering' },
        ];

        for (const { pattern, dept } of deptPatterns) {
            if (pattern.test(lowerSummary)) {
                context.department = dept;
                break;
            }
        }

        // Extract year mentions
        if (/first year|1st year/i.test(lowerSummary)) {
            context.year = 'First Year';
        } else if (/second year|2nd year/i.test(lowerSummary)) {
            context.year = 'Second Year';
        } else if (/third year|3rd year/i.test(lowerSummary)) {
            context.year = 'Third Year';
        } else if (/fourth year|4th year|final year/i.test(lowerSummary)) {
            context.year = 'Fourth Year';
        }

        return Object.keys(context).length > 0 ? context : null;
    }
}
