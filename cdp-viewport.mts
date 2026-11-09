import type {Page, BrowserContext, Frame, CDPSession} from 'playwright-core';
import {createHash} from 'node:crypto';
import {CdpJpeg} from './cdp-image-codec.mts';

export interface CdpViewportOwner {
    readonly page: Page;
    readonly pageId: string;
    getDocumentId?(): string | null;
}
export interface CdpViewportLimits {
    readonly maxSourcePixels?: number;
    readonly maxOutputPixels?: number;
    readonly maxPngBytes?: number;
    readonly maxJpegBytes?: number;
    readonly settleTimeoutMs?: number;
    readonly commandTimeoutMs?: number;
}
export interface CdpViewportSize {
    readonly pageId: string;
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor?: number;
}
export interface CdpViewportClip {readonly x: number; readonly y: number; readonly width: number; readonly height: number;}
export interface CdpViewportCapture {
    readonly pageId: string;
    readonly format?: 'png' | 'jpeg';
    readonly jpegQuality?: number;
    readonly fullPage?: boolean;
    readonly clip?: CdpViewportClip | null;
    readonly maxDimension?: number;
    readonly target?: null;
    readonly frameId?: null;
}
export interface CdpViewportMetrics {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
    readonly scrollX: number;
    readonly scrollY: number;
    readonly visualScale: number | null;
}
export class CdpViewportError extends Error {
    readonly code: string;
    readonly operationMayHaveChangedLayout: boolean;
    constructor(code: string, message: string, operationMayHaveChangedLayout = false) {
        super(message); this.name = 'CdpViewportError'; this.code = code;
        this.operationMayHaveChangedLayout = operationMayHaveChangedLayout;
    }
}

// Exact Page owner, one public page CDPSession. No context replacement, artifact store or action retries.
export class CdpViewport {
    readonly #owner: CdpViewportOwner;
    readonly #page: Page;
    readonly #context: BrowserContext;
    readonly #mainFrame: Frame;
    readonly #pageId: string;
    readonly #session: CDPSession;
    readonly #limits: Required<CdpViewportLimits>;
    readonly #onNavigated: (frame: Frame) => void;
    #generation = 0;
    #busy = false;
    #disposed = false;
    #expected: CdpViewportMetrics | null = null;
    #overrideEstablished = false;

    private constructor(owner: CdpViewportOwner, session: CDPSession, limits: Required<CdpViewportLimits>) {
        this.#owner = owner; this.#page = owner.page; this.#pageId = owner.pageId;
        this.#context = owner.page.context(); this.#mainFrame = owner.page.mainFrame();
        this.#session = session; this.#limits = limits;
        this.#onNavigated = frame => {if (frame === this.#mainFrame) this.#generation++;};
        this.#page.on('framenavigated', this.#onNavigated);
    }
    static async create(owner: CdpViewportOwner, limits: CdpViewportLimits = {}): Promise<CdpViewport> {
        if (!owner || !owner.pageId || owner.page.isClosed()) throw new CdpViewportError('PAGE_UNAVAILABLE', 'An exact live owned Page and pageId are required.');
        const configured = this.#configure(limits);
        const session = await owner.page.context().newCDPSession(owner.page);
        const helper = new CdpViewport(owner, session, configured);
        try {helper.#expected = await helper.metrics(); return helper;}
        catch (error) {helper.#page.off('framenavigated', helper.#onNavigated); await session.detach(); throw error;}
    }
    static #configure(input: CdpViewportLimits): Required<CdpViewportLimits> {
        const result = {maxSourcePixels: input.maxSourcePixels ?? 16777216, maxOutputPixels: input.maxOutputPixels ?? 4194304,
            maxPngBytes: input.maxPngBytes ?? 16777216, maxJpegBytes: input.maxJpegBytes ?? input.maxPngBytes ?? 16777216, settleTimeoutMs: input.settleTimeoutMs ?? 5000, commandTimeoutMs: input.commandTimeoutMs ?? 10000};
        for (const [name, value] of Object.entries(result)) this.#number(value, name, 1, name.endsWith('Ms') ? 30000 : 67108864, true);
        return Object.freeze(result);
    }
    static #number(value: number, name: string, minimum: number, maximum: number, integer = false): void {
        if (!Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isSafeInteger(value))
            throw new CdpViewportError('INVALID_BOUNDS', `${name} must be ${integer ? 'an integer' : 'finite'} in ${minimum}..${maximum}.`);
    }
    describe() {
        return {pageId: this.#pageId, disposed: this.#disposed, busy: this.#busy, limits: {...this.#limits},
            supported: {png: true, jpeg: CdpJpeg.availability().available, viewport: true, fullPage: true, viewportCssClip: true, desktop: true},
            jpegCodec: CdpJpeg.availability(), unsupported: [ 'element/frame capture', 'pinch/browser zoom other than 1', 'artifact admission'],
            pixelBudgetPreflight: true, hardPretransportEncodedByteLimit: false, cachePolicyChanged: false};
    }
    #assertPage(pageId = this.#pageId): void {
        if (this.#disposed) throw new CdpViewportError('DISPOSED', 'Viewport session is detached.');
        if (pageId !== this.#pageId || this.#owner.pageId !== this.#pageId || this.#owner.page !== this.#page || this.#page.context() !== this.#context || this.#page.mainFrame() !== this.#mainFrame)
            throw new CdpViewportError('PAGE_IDENTITY_CHANGED', 'Only the exact original Page/pageId/context/main frame is supported.');
        if (this.#page.isClosed()) throw new CdpViewportError('PAGE_CLOSED', 'The owned Page is closed.');
    }
    #begin(pageId: string): {generation: number; documentId: string | null} {
        this.#assertPage(pageId);
        if (this.#busy) throw new CdpViewportError('OPERATION_PENDING', 'An owned viewport operation is still pending; no retry or overlapping detach.');
        const scope = {generation: this.#generation, documentId: this.#owner.getDocumentId?.() ?? null};
        this.#busy = true; return scope;
    }
    #assertScope(scope: {generation: number; documentId: string | null}): void {
        this.#assertPage();
        if (scope.generation !== this.#generation || scope.documentId !== (this.#owner.getDocumentId?.() ?? null))
            throw new CdpViewportError('DOCUMENT_CHANGED', 'Main-frame navigation/document changed during the operation. No action was replayed.', true);
    }
    async #read(): Promise<CdpViewportMetrics> {
        return this.#page.evaluate(() => ({width: innerWidth, height: innerHeight, devicePixelRatio,
            scrollX, scrollY, visualScale: visualViewport?.scale ?? null}));
    }
    async metrics(): Promise<CdpViewportMetrics> {
        this.#assertPage(); const result = await this.#read(); this.#assertPage(); return result;
    }
    #same(a: CdpViewportMetrics, b: CdpViewportMetrics): boolean {
        return a.width === b.width && a.height === b.height && Math.abs(a.devicePixelRatio - b.devicePixelRatio) < 0.000001;
    }
    async #settle(expected: CdpViewportMetrics): Promise<CdpViewportMetrics> {
        const handle = await this.#page.waitForFunction(async e => {
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return innerWidth === e.width && innerHeight === e.height && Math.abs(devicePixelRatio - e.devicePixelRatio) < 0.000001;
        },
            expected, {polling: 'raf', timeout: this.#limits.settleTimeoutMs});
        await handle.dispose();
        const measured = await this.#read();
        if (!this.#same(measured, expected)) throw new CdpViewportError('METRICS_UNSETTLED', 'Requested CSS viewport/DPR did not remain observed after the animation-frame barrier.', true);
        return measured;
    }
    #size(args: CdpViewportSize): CdpViewportMetrics {
        CdpViewport.#number(args.width, 'width', 320, 7680, true); CdpViewport.#number(args.height, 'height', 240, 4320, true);
        const dpr = args.deviceScaleFactor ?? 1; CdpViewport.#number(dpr, 'deviceScaleFactor', 1, 4);
        if (args.width * args.height * dpr * dpr > this.#limits.maxSourcePixels)
            throw new CdpViewportError('SOURCE_PIXEL_LIMIT', 'Requested viewport native pixel area exceeds the configured source limit.');
        return {width: args.width, height: args.height, devicePixelRatio: dpr, scrollX: 0, scrollY: 0, visualScale: 1};
    }
    async resize(args: CdpViewportSize) {
        const expected = this.#size(args), scope = this.#begin(args.pageId); let dispatched = false;
        try {
            const before = await this.#read(); this.#assertScope(scope);
            const bookkeeping = this.#page.viewportSize(), updateSize = bookkeeping?.width !== args.width || bookkeeping?.height !== args.height;
            // Inherited Playwright metrics are not an override owned by this capture session.
            const noOp = this.#overrideEstablished && this.#expected !== null && !updateSize && this.#same(before, expected) && this.#same(this.#expected, expected);
            if (!noOp) {
                dispatched = true;
                if (updateSize) await this.#page.setViewportSize({width: args.width, height: args.height});
                this.#assertScope(scope);
                await this.#session.send('Emulation.setDeviceMetricsOverride', {width: args.width, height: args.height, deviceScaleFactor: expected.devicePixelRatio, mobile: false}, {timeout: this.#limits.commandTimeoutMs});
            }
            const after = await this.#settle(expected); this.#assertScope(scope); this.#expected = after; this.#overrideEstablished = true;
            return {pageId: this.#pageId, documentId: scope.documentId, before, after, noOp, layoutOperation: true,
                inputDispatched: dispatched, units: 'CSS pixels', contextRecreated: false, businessSuccessVerified: false};
        } catch (error) {if (dispatched) {this.#expected = null; this.#overrideEstablished = false;} throw error;}
        finally {this.#busy = false;}
    }
    #assertExpected(metrics: CdpViewportMetrics): void {
        if (!this.#expected || !this.#same(metrics, this.#expected)) throw new CdpViewportError('METRICS_DRIFT', 'Viewport/DPR differs from the last measured helper state; explicitly resize instead of silently reapplying.');
        if (metrics.visualScale !== 1) throw new CdpViewportError('ZOOM_UNSUPPORTED', 'Only measured visual viewport scale 1 is supported.');
    }
    #rectangle(args: CdpViewportCapture, metrics: CdpViewportMetrics, layout: any): CdpViewportClip {
        const visual = layout.cssVisualViewport;
        if (!visual || visual.scale !== 1 || visual.zoom !== undefined && visual.zoom !== 1)
            throw new CdpViewportError('ZOOM_UNSUPPORTED', 'CDP CSS/DIP capture transform requires visual scale and browser zoom 1.');
        if (args.fullPage && args.clip) throw new CdpViewportError('CONFLICTING_CROP', 'fullPage and viewport CSS clip are mutually exclusive.');
        if (args.fullPage) return this.#checkedRectangle(layout.cssContentSize);
        const clip = args.clip ?? {x: 0, y: 0, width: metrics.width, height: metrics.height};
        this.#checkedRectangle(clip);
        if (clip.x < 0 || clip.y < 0 || clip.x + clip.width > metrics.width || clip.y + clip.height > metrics.height)
            throw new CdpViewportError('CLIP_OUTSIDE_VIEWPORT', 'Clip must be inside the measured main viewport in CSS pixels.');
        return {x: metrics.scrollX + clip.x, y: metrics.scrollY + clip.y, width: clip.width, height: clip.height};
    }
    #checkedRectangle(rect: CdpViewportClip): CdpViewportClip {
        if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key as keyof CdpViewportClip])) || rect.width <= 0 || rect.height <= 0)
            throw new CdpViewportError('INVALID_CROP', 'Capture rectangle must have finite coordinates and positive dimensions.');
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    }
    #plan(rect: CdpViewportClip, metrics: CdpViewportMetrics, maxDimension: number) {
        CdpViewport.#number(maxDimension, 'maxDimension', 1, 8192, true);
        const width = rect.width * metrics.devicePixelRatio, height = rect.height * metrics.devicePixelRatio, pixels = width * height;
        if (!Number.isFinite(pixels) || pixels > this.#limits.maxSourcePixels) throw new CdpViewportError('SOURCE_PIXEL_LIMIT', 'Measured capture source pixel area exceeds the preflight limit.');
        const scale = Math.min(1, maxDimension / Math.max(width, height), Math.sqrt(this.#limits.maxOutputPixels / pixels));
        return {nativePixelExtent: {width, height}, scale, maxDimension};
    }
    #png(data: string): {bytes: Buffer; width: number; height: number; sha256: string} {
        if (typeof data !== 'string' || data.length > 4 * Math.ceil(this.#limits.maxPngBytes / 3)) throw new CdpViewportError('PNG_BYTE_LIMIT', 'CDP reply exceeded the encoded character budget; no base64 was decoded or logged.');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > this.#limits.maxPngBytes) throw new CdpViewportError('PNG_BYTE_LIMIT', 'Actual PNG bytes exceed the configured limit.');
        if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR')
            throw new CdpViewportError('PNG_HEADER_INVALID', 'CDP did not return a PNG IHDR. Core must still fully decode/validate before artifact admission.');
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (!width || !height || width * height > this.#limits.maxOutputPixels) throw new CdpViewportError('OUTPUT_PIXEL_LIMIT', 'Actual PNG dimensions exceed the configured output pixel area.');
        return {bytes, width, height, sha256: createHash('sha256').update(bytes).digest('hex')};
    }
    #jpeg(data: string): {bytes: Buffer; width: number; height: number; sha256: string} {
        if (typeof data !== 'string' || data.length > 4 * Math.ceil(this.#limits.maxJpegBytes / 3)) throw new CdpViewportError('JPEG_BYTE_LIMIT', 'CDP JPEG reply exceeded encoded character budget.');
        const bytes = Buffer.from(data, 'base64');
        if (!bytes.length || bytes.length > this.#limits.maxJpegBytes) throw new CdpViewportError('JPEG_BYTE_LIMIT', 'Actual JPEG bytes exceed configured limit.');
        const decoded = CdpJpeg.read(bytes, {maxSourceBytes: this.#limits.maxJpegBytes, maxPixels: this.#limits.maxOutputPixels});
        return {bytes, width: decoded.width, height: decoded.height, sha256: createHash('sha256').update(bytes).digest('hex')};
    }
    async capture(args: CdpViewportCapture) {
        if (args.target != null || args.frameId != null) throw new CdpViewportError('TARGET_UNSUPPORTED', 'Element and child-frame capture are not supported by this exact main-page helper.');
        const format = args.format ?? 'png', quality = args.jpegQuality ?? 85;
        if (format !== 'png' && format !== 'jpeg') throw new CdpViewportError('FORMAT_UNSUPPORTED', 'This helper captures PNG/JPEG only.');
        if (format === 'jpeg') {
            CdpViewport.#number(quality, 'jpegQuality', 0, 100, true);
            if (!CdpJpeg.availability().available) throw new CdpViewportError('CODEC_UNAVAILABLE', 'codecUnavailable: exact installed jpeg-js0.4.4 is required for JPEG capture.');
        }
        if (args.fullPage !== undefined && typeof args.fullPage !== 'boolean') throw new CdpViewportError('INVALID_CROP', 'fullPage must be boolean.');
        const scope = this.#begin(args.pageId);
        try {
            const before = await this.#read(); this.#assertExpected(before); this.#assertScope(scope);
            const layout = await this.#session.send('Page.getLayoutMetrics', {}, {timeout: this.#limits.commandTimeoutMs});
            const rectangle = this.#rectangle(args, before, layout), plan = this.#plan(rectangle, before, args.maxDimension ?? 1600);
            this.#assertScope(scope);
            const reply = await this.#session.send('Page.captureScreenshot', {format, ...(format === 'jpeg' ? {quality} : {}), fromSurface: true, captureBeyondViewport: true,
                clip: {...rectangle, scale: plan.scale}}, {timeout: this.#limits.commandTimeoutMs});
            const after = await this.#read(); this.#assertScope(scope); this.#assertExpected(after);
            if (before.scrollX !== after.scrollX || before.scrollY !== after.scrollY) throw new CdpViewportError('SCROLL_CHANGED', 'Scroll changed during capture; pixels are not returned with a guessed coordinate transform.');
            const png = format === 'jpeg' ? this.#jpeg(reply.data) : this.#png(reply.data);
            if (png.width > plan.maxDimension || png.height > plan.maxDimension) throw new CdpViewportError('OUTPUT_DIMENSION_LIMIT', 'Actual capture dimensions exceed maxDimension.');
            return {bytes: png.bytes, metadata: {pageId: this.#pageId, documentId: scope.documentId, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png', jpegQuality: format === 'jpeg' ? quality : null, byteLength: png.bytes.length,
                sha256: png.sha256, before, after, captureScale: plan.scale, nativePixelExtent: plan.nativePixelExtent,
                nativeExtentBasis: 'measured CSS rectangle times measured DPR; not an independently captured unscaled PNG',
                imageDimensions: {width: png.width, height: png.height}, pageCssRectangle: rectangle, fullPage: args.fullPage ?? false,
                imageToViewportCss: {scaleX: rectangle.width / png.width, scaleY: rectangle.height / png.height, offsetX: rectangle.x - before.scrollX, offsetY: rectangle.y - before.scrollY},
                source: 'public Page.captureScreenshot on owned page CDPSession', contextRecreated: false, fullyDecoded: format === 'jpeg', pixelValidation: format === 'jpeg' ? 'jpeg-js0.4.4 strict full RGBA decode' : 'PNG IHDR only; core PNG decoder admission remains authoritative', artifactId: null}};
        } finally {this.#busy = false;}
    }
    async dispose(options: {allowLiveDetach?: boolean} = {}) {
        if (this.#disposed) return {disposed: true, alreadyDisposed: true};
        if (this.#busy) throw new CdpViewportError('OPERATION_PENDING', 'Await the retained operation before detaching its session.');
        if (!this.#page.isClosed() && options.allowLiveDetach !== true) throw new CdpViewportError('LIVE_DETACH_REQUIRES_OWNER', 'Close the Page first, or explicitly allow live detach; native emulation may change.');
        if (!this.#page.isClosed()) this.#assertPage();
        this.#busy = true;
        try {
            const before = this.#page.isClosed() ? null : await this.#read();
            try {await this.#session.detach();}
            catch (error) {if (!this.#page.isClosed()) throw error;}
            this.#disposed = true; this.#page.off('framenavigated', this.#onNavigated);
            const after = this.#page.isClosed() ? null : await this.#read();
            return {disposed: true, alreadyDisposed: false, before, after, emulationMayChangeOnDetach: true, otherSessionsDetached: false};
        } finally {this.#busy = false;}
    }
}
