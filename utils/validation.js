import { z } from 'zod';

// Common validation schemas
const sessionIdSchema = z.string().min(1, 'Session ID is required').max(200);
const questionSchema = z.string().min(1, 'Question cannot be empty').max(5000, 'Question too long');
const languageSchema = z.enum(['english', 'hindi'], {
    errorMap: () => ({ message: 'Language must be "english" or "hindi"' })
});

// Chat validation schemas
export const chatStreamSchema = z.object({
    question: questionSchema,
    sessionId: sessionIdSchema.optional(),
    language: languageSchema.optional().default('english'),
});

export const setLanguageSchema = z.object({
    sessionId: sessionIdSchema,
    language: languageSchema,
});

export const getLanguageSchema = z.object({
    sessionId: sessionIdSchema,
});

// Auth validation schemas
export const loginSchema = z.object({
    username: z.string().min(1, 'Username is required').max(100),
    password: z.string().min(1, 'Password is required').max(100),
});

// Scrape validation schemas
export const scrapeSchema = z.object({
    startUrl: z.string().url('Invalid URL format').optional(),
    maxPages: z.number().int().min(1).max(10000).optional(),
    maxDepth: z.number().int().min(1).max(10).optional(),
    skipEmbed: z.boolean().optional(),
});

// Clear conversation schema
export const clearConversationSchema = z.object({
    sessionId: sessionIdSchema,
});

// User context schema
export const userContextSchema = z.object({
    department: z.string().max(100).optional(),
    year: z.string().max(20).optional(),
    interests: z.array(z.string().max(100)).optional(),
    role: z.enum(['student', 'faculty', 'visitor', 'other']).optional(),
});

// Validation middleware factory
export function validateBody(schema) {
    return (req, res, next) => {
        try {
            const validated = schema.parse(req.body);
            req.validatedBody = validated;
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: 'Validation failed',
                    details: error.errors.map(err => ({
                        field: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            return res.status(400).json({
                success: false,
                error: error.message || 'Invalid request',
            });
        }
    };
}

// Validate path parameters
export function validateParams(schema) {
    return (req, res, next) => {
        try {
            const validated = schema.parse(req.params);
            req.validatedParams = validated;
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: 'Validation failed',
                    details: error.errors.map(err => ({
                        field: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            return res.status(400).json({
                success: false,
                error: error.message || 'Invalid parameters',
            });
        }
    };
}

// Validate query parameters
export function validateQuery(schema) {
    return (req, res, next) => {
        try {
            const validated = schema.parse(req.query);
            req.validatedQuery = validated;
            next();
        } catch (error) {
            if (error instanceof z.ZodError) {
                return res.status(400).json({
                    success: false,
                    error: 'Validation failed',
                    details: error.errors.map(err => ({
                        field: err.path.join('.'),
                        message: err.message,
                    })),
                });
            }
            return res.status(400).json({
                success: false,
                error: error.message || 'Invalid query parameters',
            });
        }
    };
}
