/**
 * A failed legacy `initialize` must not reject `connect()` until the transport
 * has finished closing. `StdioClientTransport.close()` waits for the child to
 * exit, and that exit is what fires `onclose`. If `connect()` rejects first, a
 * retry is already the current transport when the old `onclose` arrives, and
 * `Protocol._onclose()` clears it (`Connection closed`).
 */
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/core-internal';
import { isJSONRPCRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';

const UNSUPPORTED_PROTOCOL_VERSION = '1999-01-01';

/**
 * `close()` reports that it has started, then waits. `onclose` fires when the
 * wait ends, before `close()` resolves — the same order as a stdio child exit.
 */
class DeferredCloseTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    closeStarted!: Promise<void>;
    private resolveCloseStarted!: () => void;
    private releaseClose: () => void = () => {
        throw new Error('close() is not waiting');
    };

    constructor(private readonly protocolVersion: string) {
        this.closeStarted = new Promise(resolve => {
            this.resolveCloseStarted = resolve;
        });
    }

    async start(): Promise<void> {}

    async send(message: JSONRPCMessage): Promise<void> {
        if (!isJSONRPCRequest(message) || message.method !== 'initialize') return;
        this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: this.protocolVersion,
                capabilities: {},
                serverInfo: { name: 's', version: '0' }
            }
        });
    }

    async close(): Promise<void> {
        this.resolveCloseStarted();
        await new Promise<void>(resolve => {
            this.releaseClose = resolve;
        });
        this.onclose?.();
    }

    /** The child has exited: deliver `onclose`, then let `close()` resolve. */
    finishClose(): void {
        this.releaseClose();
    }
}

describe('failed initialize handshake', () => {
    test('connect() rejects with the handshake error only after the transport has closed, and a retry stays up', async () => {
        const client = new Client({ name: 'c', version: '0' });
        const bad = new DeferredCloseTransport(UNSUPPORTED_PROTOCOL_VERSION);

        const first = client.connect(bad).then(
            () => undefined,
            (error: unknown) => error
        );
        await bad.closeStarted;

        // close() has started, but the transport has not exited. connect() must
        // still be pending: a rejection here is what lets a retry race the old onclose.
        const early = await Promise.race([
            first.then(error => ({ settled: true as const, error })),
            new Promise(resolve => setTimeout(resolve, 0)).then(() => ({ settled: false as const, error: undefined }))
        ]);
        expect(early.settled).toBe(false);
        expect(client.transport).toBe(bad);

        bad.finishClose();
        const error = await first;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(`Server's protocol version is not supported: ${UNSUPPORTED_PROTOCOL_VERSION}`);
        expect(client.transport).toBeUndefined();

        const good = new DeferredCloseTransport(LATEST_PROTOCOL_VERSION);
        await client.connect(good);
        expect(client.getServerVersion()).toEqual({ name: 's', version: '0' });
        expect(client.transport).toBe(good);

        const closing = client.close();
        await good.closeStarted;
        good.finishClose();
        await closing;
        expect(client.transport).toBeUndefined();
    });

    test('an error from close() does not replace the handshake error', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const client = new Client({ name: 'c', version: '0' });
            const bad = new DeferredCloseTransport(UNSUPPORTED_PROTOCOL_VERSION);
            const close = bad.close.bind(bad);
            bad.close = async () => {
                await close();
                throw new Error('close failed');
            };

            const first = client.connect(bad).then(
                () => undefined,
                (error: unknown) => error
            );
            await bad.closeStarted;
            bad.finishClose();

            const error = await first;
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(`Server's protocol version is not supported: ${UNSUPPORTED_PROTOCOL_VERSION}`);
            expect(client.transport).toBeUndefined();

            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});
