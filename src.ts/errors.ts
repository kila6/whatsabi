export class WhatsABIError extends Error {
    override name = 'WhatsABIError';

    // Some variables included from the context scope of the error, for debugging
    context?: Record<string, any>;

    constructor(message: string, args: { context?: Record<string, any>, cause?: Error } = {}) {
        super(message, { cause: args.cause } as ErrorOptions);

        this.context = args.context;
    }
}
