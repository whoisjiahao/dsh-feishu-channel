/** Streamed, size-bounded intake for images attached to a Feishu message. */
import type { NormalizedMessage } from '@larksuite/channel';
import type { HostAttachments, HostContentBlock } from './host.ts';
/** Resource operation used to keep untrusted payloads outside the JS heap. */
export interface ImagePort {
    downloadResourceToFile(messageId: string, fileKey: string, type: 'image' | 'file', destPath: string): Promise<{
        readonly bytesWritten: number;
        readonly contentType?: string | undefined;
    }>;
}
export interface CollectedImages {
    readonly blocks: HostContentBlock[];
    readonly notes: string[];
}
/** Download accepted images, commit bounded bytes, and always remove staging files. */
export declare function collectImages(message: NormalizedMessage, port: ImagePort, attachments: HostAttachments | undefined, enabled: boolean, signal?: AbortSignal, disabledNote?: string): Promise<CollectedImages>;
export declare function emptyCollection(): CollectedImages;
export declare function noteOnly(note: string): CollectedImages;
//# sourceMappingURL=images.d.ts.map