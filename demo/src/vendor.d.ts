declare module "@ffmpeg/ffmpeg" {
  export class FFmpeg {
    readonly loaded: boolean;
    load(config?: Record<string, string>, options?: { signal?: AbortSignal }): Promise<boolean>;
    exec(args: string[], timeout?: number, options?: { signal?: AbortSignal }): Promise<number>;
    ffprobe(args: string[], timeout?: number, options?: { signal?: AbortSignal }): Promise<number>;
    writeFile(path: string, data: Uint8Array | string, options?: { signal?: AbortSignal }): Promise<boolean>;
    readFile(path: string, encoding?: "binary" | "utf8", options?: { signal?: AbortSignal }): Promise<Uint8Array | string>;
    deleteFile(path: string, options?: { signal?: AbortSignal }): Promise<boolean>;
    listDir(path: string, options?: { signal?: AbortSignal }): Promise<Array<{ name: string; isDir: boolean }>>;
    terminate(): void;
    on(event: "log", callback: (event: { type: string; message: string }) => void): void;
    on(event: "progress", callback: (event: { progress: number; time: number }) => void): void;
    off(event: "log", callback: (event: { type: string; message: string }) => void): void;
    off(event: "progress", callback: (event: { progress: number; time: number }) => void): void;
  }
}

declare module "@ffmpeg/util" {
  export function toBlobURL(url: string, mimeType: string): Promise<string>;
}
