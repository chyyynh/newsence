// ─────────────────────────────────────────────────────────────
// Bilibili gRPC Client (HTTP/2 over TLS via cloudflare:sockets)
// ─────────────────────────────────────────────────────────────
// @ts-nocheck — proto imports are untyped JS

import { connect } from 'cloudflare:sockets';
import HPACK from 'hpack';
import forge from 'node-forge';
import { DynSpaceReq, DynSpaceRsp } from './gen/bilibili/app/dynamic/v2/dynamic_pb.js';
import { Device } from './gen/bilibili/metadata/device/device_pb.js';
import { Locale } from './gen/bilibili/metadata/locale/locale_pb.js';
import { Metadata } from './gen/bilibili/metadata/metadata_pb.js';
import { Network, NetworkType } from './gen/bilibili/metadata/network/network_pb.js';

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function getRandomBuvid(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let buvid = 'XX';
	for (let i = 0; i < 35; i++) {
		buvid += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return buvid;
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

// ─────────────────────────────────────────────────────────────
// Protobuf Metadata Headers
// ─────────────────────────────────────────────────────────────

function getBilibiliMetadata(accessKey?: string, buvid?: string): Record<string, string> {
	const bv = buvid || getRandomBuvid();

	const device = new Device({
		appId: 1,
		build: 8240300,
		buvid: bv,
		mobiApp: 'android',
		platform: 'android',
		device: 'phone',
		channel: 'master',
		brand: 'Xiaomi',
		model: 'Redmi K30 Pro',
		osver: '12',
	});

	const locale = new Locale({
		cLocale: { language: 'zh', region: 'CN' },
		sLocale: { language: 'zh', region: 'CN' },
	});

	const network = new Network({
		type: NetworkType.WIFI,
	});

	const metadata = new Metadata({
		accessKey: accessKey || '',
		mobiApp: 'android',
		device: 'phone',
		build: 8240300,
		channel: 'master',
		buvid: bv,
		platform: 'android',
	});

	return {
		'x-bili-device-bin': uint8ToBase64(device.toBinary()),
		'x-bili-locale-bin': uint8ToBase64(locale.toBinary()),
		'x-bili-metadata-bin': uint8ToBase64(metadata.toBinary()),
		'x-bili-network-bin': uint8ToBase64(network.toBinary()),
	};
}

function getHeaders(accessKey?: string): Array<[string, string]> {
	const buvid = getRandomBuvid();
	const biliMeta = getBilibiliMetadata(accessKey, buvid);
	return [
		[
			'user-agent',
			'Dalvik/2.1.0 (Linux; U; Android 12; Redmi K30 Pro Build/SKQ1.211006.001) 8.24.0 os/android model/Redmi K30 Pro mobi_app/android build/8240300 channel/master innerVer/8240310 osVer/12 network/2',
		],
		['te', 'trailers'],
		['x-bili-gaia-vtoken', ''],
		['x-bili-aurora-eid', ''],
		['x-bili-mid', '0'],
		['x-bili-aurora-zone', ''],
		[
			'x-bili-trace-id',
			`${Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}:${Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}:0:0`,
		],
		['buvid', buvid],
		['authorization', accessKey ? `identify_v1 ${accessKey}` : ''],
		['content-type', 'application/grpc'],
		['accept-encoding', 'gzip'],
		['grpc-encoding', 'identity'],
		['grpc-accept-encoding', 'identity,gzip'],
		['grpc-timeout', '17985168u'],
		...(Object.entries(biliMeta) as Array<[string, string]>),
	];
}

// ─────────────────────────────────────────────────────────────
// gRPC Frame Encoding / Decoding
// ─────────────────────────────────────────────────────────────

function dataToGrpc(data: Uint8Array): Uint8Array {
	const header = new Uint8Array(5);
	header[0] = 0; // uncompressed
	const len = data.length;
	header[1] = (len >> 24) & 0xff;
	header[2] = (len >> 16) & 0xff;
	header[3] = (len >> 8) & 0xff;
	header[4] = len & 0xff;
	const result = new Uint8Array(5 + data.length);
	result.set(header);
	result.set(data, 5);
	return result;
}

function grpcToData(rsp: Uint8Array): Uint8Array {
	if (rsp.length < 5) return new Uint8Array(0);
	const len = (rsp[1] << 24) | (rsp[2] << 16) | (rsp[3] << 8) | rsp[4];
	return rsp.slice(5, 5 + len);
}

// ─────────────────────────────────────────────────────────────
// HTTP/2 Manual Frame Construction + TLS via forge
// ─────────────────────────────────────────────────────────────

const H2_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

// SETTINGS frame (type=4, flags=0, stream=0)
const SETTINGS_FRAME = new Uint8Array([
	0x00,
	0x00,
	0x12, // length = 18
	0x04, // type = SETTINGS
	0x00, // flags
	0x00,
	0x00,
	0x00,
	0x00, // stream id = 0
	// SETTINGS_HEADER_TABLE_SIZE = 4096
	0x00,
	0x01,
	0x00,
	0x00,
	0x10,
	0x00,
	// SETTINGS_INITIAL_WINDOW_SIZE = 4194304
	0x00,
	0x04,
	0x00,
	0x40,
	0x00,
	0x00,
	// SETTINGS_MAX_FRAME_SIZE = 4194304
	0x00,
	0x05,
	0x00,
	0x40,
	0x00,
	0x00,
]);

// WINDOW_UPDATE frame (type=8, stream=0, increment=1073741823)
const WINDOW_UPDATE_FRAME = new Uint8Array([
	0x00,
	0x00,
	0x04, // length = 4
	0x08, // type = WINDOW_UPDATE
	0x00, // flags
	0x00,
	0x00,
	0x00,
	0x00, // stream id = 0
	0x3f,
	0xff,
	0x00,
	0x01, // increment
]);

// SETTINGS ACK (type=4, flags=1, stream=0, no payload)
const SETTINGS_ACK = new Uint8Array([
	0x00,
	0x00,
	0x00, // length = 0
	0x04, // type = SETTINGS
	0x01, // flags = ACK
	0x00,
	0x00,
	0x00,
	0x00,
]);

function buildHeadersFrame(path: string, headers: Array<[string, string]>): Uint8Array {
	const hpackEncoder = new HPACK();
	const allHeaders: Array<[string, string]> = [
		[':method', 'POST'],
		[':scheme', 'https'],
		[':authority', 'grpc.biliapi.net'],
		[':path', path],
		...headers,
	];
	const encoded: Uint8Array = new Uint8Array(hpackEncoder.encode(allHeaders));
	// HEADERS frame: type=1, flags=0x24 (END_HEADERS | PRIORITY... actually 0x04=END_HEADERS + 0x20=PRIORITY... let's use 0x04 = END_HEADERS only)
	// Original code uses 0x24 = END_HEADERS (0x04) + PRIORITY (0x20)
	const frame = new Uint8Array(9 + encoded.length);
	const len = encoded.length;
	frame[0] = (len >> 16) & 0xff;
	frame[1] = (len >> 8) & 0xff;
	frame[2] = len & 0xff;
	frame[3] = 0x01; // type = HEADERS
	frame[4] = 0x04; // flags = END_HEADERS
	// stream id = 1
	frame[5] = 0x00;
	frame[6] = 0x00;
	frame[7] = 0x00;
	frame[8] = 0x01;
	frame.set(encoded, 9);
	return frame;
}

function buildDataFrame(body: Uint8Array): Uint8Array {
	const frame = new Uint8Array(9 + body.length);
	const len = body.length;
	frame[0] = (len >> 16) & 0xff;
	frame[1] = (len >> 8) & 0xff;
	frame[2] = len & 0xff;
	frame[3] = 0x00; // type = DATA
	frame[4] = 0x01; // flags = END_STREAM
	// stream id = 1
	frame[5] = 0x00;
	frame[6] = 0x00;
	frame[7] = 0x00;
	frame[8] = 0x01;
	frame.set(body, 9);
	return frame;
}

interface H2Frame {
	length: number;
	type: number;
	flags: number;
	streamId: number;
	payload: Uint8Array;
}

function parseH2Frames(buffer: Uint8Array): H2Frame[] {
	const frames: H2Frame[] = [];
	let offset = 0;
	while (offset + 9 <= buffer.length) {
		const length = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
		const type = buffer[offset + 3];
		const flags = buffer[offset + 4];
		const streamId = ((buffer[offset + 5] & 0x7f) << 24) | (buffer[offset + 6] << 16) | (buffer[offset + 7] << 8) | buffer[offset + 8];
		if (offset + 9 + length > buffer.length) break;
		const payload = buffer.slice(offset + 9, offset + 9 + length);
		frames.push({ length, type, flags, streamId, payload });
		offset += 9 + length;
	}
	return frames;
}

async function biliGrpcFetch(path: string, grpcBody: Uint8Array): Promise<Uint8Array> {
	const headers = getHeaders();
	const headersFrame = buildHeadersFrame(path, headers);
	const dataFrame = buildDataFrame(grpcBody);

	return new Promise<Uint8Array>((resolve, reject) => {
		const socket = connect({ hostname: 'grpc.biliapi.net', port: 443 });
		const writer = socket.writable.getWriter();
		const reader = socket.readable.getReader();

		const responseChunks: Uint8Array[] = [];
		let resolved = false;

		const tls = forge.tls.createConnection({
			server: false,
			verify: () => true,
			connected(conn) {
				// Send HTTP/2 connection preface
				conn.prepare(H2_PREFACE);
				// Send SETTINGS frame
				conn.prepare(forge.util.binary.raw.encode(SETTINGS_FRAME));
				// Send WINDOW_UPDATE frame
				conn.prepare(forge.util.binary.raw.encode(WINDOW_UPDATE_FRAME));
				// Send HEADERS frame
				conn.prepare(forge.util.binary.raw.encode(headersFrame));
				// Send DATA frame
				conn.prepare(forge.util.binary.raw.encode(dataFrame));
				// Send SETTINGS ACK
				conn.prepare(forge.util.binary.raw.encode(SETTINGS_ACK));
			},
			tlsDataReady(conn) {
				const bytes = conn.tlsData.getBytes();
				const uint8 = forge.util.binary.raw.decode(bytes);
				writer.write(uint8).catch(() => {});
			},
			dataReady(conn) {
				const bytes = conn.data.getBytes();
				const uint8 = forge.util.binary.raw.decode(bytes);
				responseChunks.push(uint8);

				// Parse frames and look for DATA frames on stream 1
				const all = concatUint8Arrays(responseChunks);
				const frames = parseH2Frames(all);
				for (const frame of frames) {
					// DATA frame on stream 1 with END_STREAM
					if (frame.type === 0 && frame.streamId === 1 && !resolved) {
						resolved = true;
						resolve(frame.payload);
						try {
							writer.close();
						} catch {
							// ignore
						}
					}
				}
			},
			closed() {
				if (!resolved) {
					reject(new Error('TLS connection closed before receiving response'));
				}
			},
			error(_conn, error) {
				if (!resolved) {
					reject(new Error(`TLS error: ${error.message}`));
				}
			},
		});

		// Read from socket and feed into TLS
		(async () => {
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value) {
						tls.process(forge.util.binary.raw.encode(value));
					}
				}
				tls.close();
			} catch {
				if (!resolved) {
					reject(new Error('Socket read error'));
				}
			}
		})();

		// Initiate TLS handshake
		tls.handshake();

		// Timeout after 15 seconds
		setTimeout(() => {
			if (!resolved) {
				resolved = true;
				reject(new Error('biliGrpcFetch timeout'));
				try {
					writer.close();
				} catch {
					// ignore
				}
			}
		}, 15000);
	});
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	let totalLength = 0;
	for (const arr of arrays) totalLength += arr.length;
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

export async function getDynSpace(uid: string): Promise<string> {
	const req = new DynSpaceReq({ hostUid: BigInt(uid) });
	const reqBytes = dataToGrpc(req.toBinary());

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const rspBytes = await biliGrpcFetch('/bilibili.app.dynamic.v2.Dynamic/DynSpace', reqBytes);
			const data = grpcToData(rspBytes);
			const rsp = DynSpaceRsp.fromBinary(data);
			return JSON.stringify(rsp.toJson());
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES - 1) {
				await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
			}
		}
	}
	throw lastError ?? new Error('getDynSpace failed');
}
