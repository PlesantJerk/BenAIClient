import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

type JpegModule = typeof import('jpeg-js');
export interface CdpJpegLimits {
    readonly maxSourceBytes?: number;
    readonly maxOutputBytes?: number;
    readonly maxPixels?: number;
    readonly maxDimension?: number;
    readonly maxMemoryMiB?: number;
}
export interface CdpJpegPixels {readonly width: number; readonly height: number; readonly channels: 4; readonly pixels: Buffer;}
export interface CdpJpegEncoded {
    readonly bytes: Buffer; readonly mimeType: 'image/jpeg'; readonly width: number; readonly height: number;
    readonly byteLength: number; readonly sha256: string; readonly quality: number | null;
}
export interface CdpJpegResize extends CdpJpegEncoded {
    readonly sourceWidth: number; readonly sourceHeight: number; readonly sourceByteLength: number; readonly sourceSha256: string;
    readonly scaled: boolean; readonly reencoded: boolean; readonly scalingMethod: 'none' | 'nearest-neighbor';
}
export class CdpImageCodecError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {super(message); this.name = 'CdpImageCodecError'; this.code = code;}
}

/** Internal synchronous codec only. No files, artifact registry, browser, installs or alternative codec. */
export class CdpJpeg {
    static readonly maximumPixels = 16777216;
    static readonly retainedResizeQuality = 85;
    static readonly #require = createRequire(import.meta.url);
    static #codec: JpegModule | null = null;
    static #state: {available: boolean; codec: 'jpeg-js'; requiredVersion: '0.4.4'; actualVersion: string | null; resolvedPath: string | null; reason: string | null} | null = null;

    static availability() {
        if (this.#state) return {...this.#state};
        const state = {available: false, codec: 'jpeg-js' as const, requiredVersion: '0.4.4' as const, actualVersion: null as string | null,
            resolvedPath: null as string | null, reason: 'codecUnavailable' as string | null};
        try {
            const metadata = this.#require(this.#require.resolve('jpeg-js/package.json'));
            state.actualVersion = typeof metadata.version === 'string' ? metadata.version : null;
            state.resolvedPath = this.#require.resolve('jpeg-js');
            if (state.actualVersion === state.requiredVersion) {
                const codec = this.#require(state.resolvedPath) as JpegModule;
                if (typeof codec.decode === 'function' && typeof codec.encode === 'function') {this.#codec = codec; state.available = true; state.reason = null;}
            }
        } catch { /* Absence is reported, never fetched or substituted. */ }
        this.#state = Object.freeze(state); return {...state};
    }
    static #get(): JpegModule {
        const state = this.availability();
        if (!state.available || !this.#codec) throw new CdpImageCodecError('CODEC_UNAVAILABLE', 'codecUnavailable: exact installed jpeg-js0.4.4 is required.');
        return this.#codec;
    }
    static #limits(input: CdpJpegLimits): Required<CdpJpegLimits> {
        const value = {maxSourceBytes: input.maxSourceBytes ?? 16777216, maxOutputBytes: input.maxOutputBytes ?? 16777216,
            maxPixels: input.maxPixels ?? this.maximumPixels, maxDimension: input.maxDimension ?? 8192, maxMemoryMiB: input.maxMemoryMiB ?? 128};
        for (const [name, number] of Object.entries(value)) {
            const maximum = name === 'maxMemoryMiB' ? 256 : name === 'maxDimension' ? 8192 : 67108864;
            if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new CdpImageCodecError('INVALID_IMAGE_LIMIT', `${name} must be an integer in 1..${maximum}.`);
        }
        return value;
    }
    static #dimensions(width: number, height: number, limits: Required<CdpJpegLimits>): void {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
            width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels)
            throw new CdpImageCodecError('IMAGE_LIMIT', 'JPEG dimensions/pixel area exceed the configured bounds.');
    }
    // Only bounded SOF preflight. It is NEVER used as evidence of full pixel decoding.
    static #header(bytes: Buffer, limits: Required<CdpJpegLimits>): {width: number; height: number} {
        if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > limits.maxSourceBytes) throw new CdpImageCodecError('IMAGE_LIMIT', 'JPEG source is empty, too short or exceeds encoded-byte bound.');
        if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new CdpImageCodecError('JPEG_INVALID', 'Strict JPEG framing requires SOI and terminal EOI.');
        let offset = 2, dimensions: {width: number; height: number} | null = null;
        for (let segments = 0; segments < 4096 && offset + 3 < bytes.length; segments++) {
            if (bytes[offset++] !== 0xff) break;
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++]; if (offset + 2 > bytes.length || marker === 0xd9) break;
            const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length - 2) break;
            if (marker === 0xda) {
                if (!dimensions || length < 6 || offset + length >= bytes.length - 2) break;
                return dimensions;
            }
            if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                if (length < 8 || bytes[offset + 2] !== 8) throw new CdpImageCodecError('JPEG_UNSUPPORTED', 'Only 8-bit SOF0/SOF1/SOF2 JPEG is supported.');
                const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
                this.#dimensions(width, height, limits); dimensions = {width, height};
            }
            offset += length;
        }
        throw new CdpImageCodecError('JPEG_INVALID', 'Bounded JPEG SOF preflight failed.');
    }
    static read(bytes: Buffer, input: CdpJpegLimits = {}): CdpJpegPixels {
        const limits = this.#limits(input), codec = this.#get(), expected = this.#header(bytes, limits);
        let decoded: {width: number; height: number; data: Uint8Array};
        try {
            decoded = codec.decode(bytes, {useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
                maxResolutionInMP: limits.maxPixels / 1000000, maxMemoryUsageInMB: limits.maxMemoryMiB});
        } catch (error) {
            const message = String(error instanceof Error ? error.message : error).slice(0, 256);
            throw new CdpImageCodecError(/maxMemoryUsageInMB|maxResolutionInMP/.test(message) ? 'IMAGE_LIMIT' : 'JPEG_INVALID', 'jpeg-js strict decode rejected the image: ' + message);
        }
        this.#dimensions(decoded.width, decoded.height, limits);
        if (decoded.width !== expected.width || decoded.height !== expected.height || !(decoded.data instanceof Uint8Array) || decoded.data.byteLength !== decoded.width * decoded.height * 4)
            throw new CdpImageCodecError('JPEG_INVALID', 'Full JPEG decoder did not return the expected complete RGBA raster.');
        return {width: decoded.width, height: decoded.height, channels: 4, pixels: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)};
    }
    static #encoded(bytes: Buffer, width: number, height: number, quality: number | null): CdpJpegEncoded {
        return {bytes, mimeType: 'image/jpeg', width, height, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), quality};
    }
    static encode(image: {width: number; height: number; pixels: Buffer}, quality = 85, input: CdpJpegLimits = {}): CdpJpegEncoded {
        const limits = this.#limits(input), codec = this.#get(); this.#dimensions(image.width, image.height, limits);
        if (!Buffer.isBuffer(image.pixels) || image.pixels.byteLength !== image.width * image.height * 4) throw new CdpImageCodecError('JPEG_INVALID', 'JPEG encoder requires one complete RGBA raster.');
        if (!Number.isSafeInteger(quality) || quality < 1 || quality > 100) throw new CdpImageCodecError('INVALID_JPEG_QUALITY', 'RGBA encoding quality must be an integer in 1..100.');
        const result = codec.encode({width: image.width, height: image.height, data: image.pixels}, quality), bytes = result.data;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limits.maxOutputBytes) throw new CdpImageCodecError('IMAGE_LIMIT', 'Encoded JPEG exceeds its output byte bound; no quality fallback was attempted.');
        const actual = this.read(bytes, {...limits, maxSourceBytes: limits.maxOutputBytes});
        if (actual.width !== image.width || actual.height !== image.height) throw new CdpImageCodecError('JPEG_INVALID', 'Encoded JPEG decoded to unexpected dimensions.');
        return this.#encoded(bytes, actual.width, actual.height, quality);
    }
    static #resample(source: CdpJpegPixels, width: number, height: number): Buffer {
        const pixels = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const from = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
            source.pixels.copy(pixels, (y * width + x) * 4, from, from + 4);
        }
        return pixels;
    }
    static resize(bytes: Buffer, maximumDimension: number, input: CdpJpegLimits = {}): CdpJpegResize {
        const limits = this.#limits(input);
        if (!Number.isSafeInteger(maximumDimension) || maximumDimension < 1 || maximumDimension > limits.maxDimension) throw new CdpImageCodecError('INVALID_IMAGE_LIMIT', 'Resize maximumDimension is outside configured bounds.');
        const source = this.read(bytes, limits), ratio = Math.min(1, maximumDimension / Math.max(source.width, source.height));
        const width = Math.max(1, Math.floor(source.width * ratio)), height = Math.max(1, Math.floor(source.height * ratio)), scaled = ratio < 1;
        let result: CdpJpegEncoded;
        if (scaled) result = this.encode({width, height, pixels: this.#resample(source, width, height)}, this.retainedResizeQuality, limits);
        else {
            if (bytes.length > limits.maxOutputBytes) throw new CdpImageCodecError('IMAGE_LIMIT', 'Unchanged retained JPEG exceeds output byte bound.');
            result = this.#encoded(Buffer.from(bytes), source.width, source.height, null);
        }
        return {...result, sourceWidth: source.width, sourceHeight: source.height, sourceByteLength: bytes.length,
            sourceSha256: createHash('sha256').update(bytes).digest('hex'), scaled, reencoded: scaled, scalingMethod: scaled ? 'nearest-neighbor' : 'none'};
    }
}
