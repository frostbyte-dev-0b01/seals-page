// Serves pre-compressed .pck variants based on the client's Accept-Encoding.
// The build pipeline emits <name>.pck.br and <name>.pck.gz alongside <name>.pck.
// When neither encoding is accepted (or the sidecar is missing), we return
// undefined and let Netlify serve the original uncompressed .pck.

export default async function handler(request) {
	const url = new URL(request.url);
	const accept = (request.headers.get("Accept-Encoding") || "").toLowerCase();

	let encoding = null;
	let suffix = "";
	if (accept.includes("br")) {
		encoding = "br";
		suffix = ".br";
	} else if (accept.includes("gzip")) {
		encoding = "gzip";
		suffix = ".gz";
	}

	if (!encoding) {
		return;
	}

	const compressedUrl = new URL(url.pathname + suffix, url.origin);
	const upstream = await fetch(compressedUrl.toString());

	if (!upstream.ok) {
		return;
	}

	const headers = new Headers();
	headers.set("Content-Type", "application/octet-stream");
	headers.set("Content-Encoding", encoding);
	headers.set("Vary", "Accept-Encoding");
	headers.set("Cache-Control", "public, max-age=31536000, immutable");

	const contentLength = upstream.headers.get("content-length");
	if (contentLength) {
		headers.set("Content-Length", contentLength);
	}

	return new Response(upstream.body, {
		status: 200,
		headers,
	});
}

export const config = {
	path: "/index-*.pck",
};
