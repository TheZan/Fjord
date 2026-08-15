// Test-only local HTTP stand-in for api.github.com, shared by the
// release-discovery CLI test files. `github-releases-client.mjs` reads
// `FJORD_GITHUB_API_BASE` to redirect its requests here instead of the real
// GitHub API — production code never sets that variable.

import http from "node:http";

export function startMockGitHubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: String(error) }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

export function stopMockGitHubServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
