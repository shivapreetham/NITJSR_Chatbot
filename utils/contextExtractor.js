// Extract user context from conversation messages
export class ContextExtractor {
    constructor() {
        this.departments = [
            'computer science', 'cs', 'cse', 'computer engineering',
            'mechanical', 'mech', 'me', 'mechanical engineering',
            'electrical', 'ee', 'eee', 'electrical engineering',
            'civil', 'ce', 'civil engineering',
            'electronics', 'ece', 'electronics and communication',
            'chemical', 'che', 'chemical engineering',
            'metallurgy', 'mme', 'metallurgical', 'materials',
            'production', 'pie', 'production engineering',
            'it', 'information technology',
        ];

        this.years = ['first year', '1st year', 'second year', '2nd year', 'third year', '3rd year', 'fourth year', '4th year', 'final year'];
    }

    extractDepartment(text) {
        const lowerText = text.toLowerCase();

        // Check for explicit statements
        const deptPatterns = [
            /(?:i am|i'm|im)\s+(?:from|in|a|an)?\s*([a-z\s]+?)\s+(?:student|department|branch)/i,
            /(?:studying|pursuing)\s+(?:in)?\s*([a-z\s]+?)(?:\s+engineering)?/i,
            /(?:my|our)\s+(?:department|branch)\s+is\s+([a-z\s]+)/i,
            /(?:from|in)\s+(?:the)?\s*([a-z\s]+?)\s+(?:department|branch)/i,
        ];

        for (const pattern of deptPatterns) {
            const match = lowerText.match(pattern);
            if (match && match[1]) {
                const dept = match[1].trim();
                return this.normalizeDepartment(dept);
            }
        }

        // Fallback: check if any department keyword is mentioned
        for (const dept of this.departments) {
            if (lowerText.includes(dept)) {
                return this.normalizeDepartment(dept);
            }
        }

        return null;
    }

    normalizeDepartment(dept) {
        const normalized = dept.toLowerCase().trim();

        if (['computer science', 'cs', 'cse', 'computer engineering'].some(d => normalized.includes(d))) {
            return 'Computer Science and Engineering';
        }
        if (['mechanical', 'mech', 'me'].some(d => normalized.includes(d))) {
            return 'Mechanical Engineering';
        }
        if (['electrical', 'ee', 'eee'].some(d => normalized.includes(d))) {
            return 'Electrical Engineering';
        }
        if (['civil', 'ce'].some(d => normalized.includes(d))) {
            return 'Civil Engineering';
        }
        if (['electronics', 'ece'].some(d => normalized.includes(d))) {
            return 'Electronics and Communication Engineering';
        }
        if (['chemical', 'che'].some(d => normalized.includes(d))) {
            return 'Chemical Engineering';
        }
        if (['metallurgy', 'mme', 'metallurgical', 'materials'].some(d => normalized.includes(d))) {
            return 'Metallurgical and Materials Engineering';
        }
        if (['production', 'pie'].some(d => normalized.includes(d))) {
            return 'Production and Industrial Engineering';
        }
        if (['it', 'information technology'].some(d => normalized.includes(d))) {
            return 'Information Technology';
        }

        return dept;
    }

    extractYear(text) {
        const lowerText = text.toLowerCase();

        const yearPatterns = [
            /(?:i am|i'm|im)\s+(?:a|an|in)?\s*(first|second|third|fourth|final|1st|2nd|3rd|4th)\s+year/i,
            /(?:my|our)\s+year\s+is\s+(first|second|third|fourth|final|1st|2nd|3rd|4th)/i,
        ];

        for (const pattern of yearPatterns) {
            const match = lowerText.match(pattern);
            if (match && match[1]) {
                return this.normalizeYear(match[1]);
            }
        }

        return null;
    }

    normalizeYear(year) {
        const normalized = year.toLowerCase();
        if (['first', '1st'].includes(normalized)) return 'First Year';
        if (['second', '2nd'].includes(normalized)) return 'Second Year';
        if (['third', '3rd'].includes(normalized)) return 'Third Year';
        if (['fourth', '4th', 'final'].includes(normalized)) return 'Fourth Year';
        return year;
    }

    extractRole(text) {
        const lowerText = text.toLowerCase();

        if (/\b(?:i am|i'm|im)\s+(?:a|an)?\s*student\b/i.test(lowerText)) {
            return 'student';
        }
        if (/\b(?:i am|i'm|im)\s+(?:a|an)?\s*(?:professor|faculty|teacher|instructor)\b/i.test(lowerText)) {
            return 'faculty';
        }
        if (/\b(?:i am|i'm|im)\s+(?:just\s+)?(?:visiting|a visitor)\b/i.test(lowerText)) {
            return 'visitor';
        }

        return null;
    }

    extractContext(message) {
        const context = {};

        const department = this.extractDepartment(message);
        if (department) {
            context.department = department;
        }

        const year = this.extractYear(message);
        if (year) {
            context.year = year;
        }

        const role = this.extractRole(message);
        if (role) {
            context.role = role;
        }

        return Object.keys(context).length > 0 ? context : null;
    }

    buildContextSummary(userContext) {
        if (!userContext) return '';

        const parts = [];

        if (userContext.role) {
            parts.push(`Role: ${userContext.role}`);
        }
        if (userContext.department) {
            parts.push(`Department: ${userContext.department}`);
        }
        if (userContext.year) {
            parts.push(`Year: ${userContext.year}`);
        }
        if (userContext.interests && userContext.interests.length > 0) {
            parts.push(`Interests: ${userContext.interests.join(', ')}`);
        }

        if (parts.length === 0) return '';

        return `\n\nUser Context:\n${parts.join('\n')}\nUse this context to personalize responses and disambiguate queries.\n`;
    }
}
