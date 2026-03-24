// Simple Context Extractor - Extracts general conversation context
// Focuses on what the LLM will extract from summary anyway

export class SimpleContextExtractor {
    /**
     * Extracts basic user information from messages
     * LLM summary will handle the complex extraction
     */
    extractBasicInfo(message) {
        const context = {};
        const lowerText = message.toLowerCase();

        // Check if user identifies as student/faculty
        if (/\b(?:i am|i'm|im)\s+(?:a|an)?\s*student\b/i.test(lowerText)) {
            context.role = 'student';
        } else if (/\b(?:i am|i'm|im)\s+(?:a|an)?\s*(?:professor|faculty|teacher|instructor)\b/i.test(lowerText)) {
            context.role = 'faculty';
        }

        // Extract any mentioned interests/topics for tracking
        const interestPatterns = [
            /interested in (.+?)(?:\.|,|$)/i,
            /looking for (.+?)(?:\.|,|$)/i,
            /want to know about (.+?)(?:\.|,|$)/i,
        ];

        for (const pattern of interestPatterns) {
            const match = lowerText.match(pattern);
            if (match && match[1]) {
                if (!context.interests) context.interests = [];
                context.interests.push(match[1].trim());
            }
        }

        return Object.keys(context).length > 0 ? context : null;
    }

    /**
     * Build a simple context string for prompts
     */
    buildContextString(userContext) {
        if (!userContext) return '';

        const parts = [];
        if (userContext.role) {
            parts.push(`User is a ${userContext.role}`);
        }
        if (userContext.interests && userContext.interests.length > 0) {
            parts.push(`Interested in: ${userContext.interests.join(', ')}`);
        }

        return parts.length > 0 ? parts.join(' | ') : '';
    }
}
