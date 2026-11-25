import Foundation

public typealias HTTPTransport = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
public func ephemeralTransport() -> HTTPTransport {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 300
    let session = URLSession(configuration: configuration)
    return { request in
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, response)
    }
}
func validateBase(_ url: URL) throws {
    let local = ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")
    guard url.host != nil, url.user == nil, url.password == nil,
          url.query == nil, url.fragment == nil,
          url.scheme == "https" || (local && url.scheme == "http") else {
        throw ChatbotAPIError(status: 0, code: "configuration", message: "Use an HTTPS server URL (HTTP is allowed only for local development).")
    }
}
func apiFailure(_ data: Data, status: Int) -> ChatbotAPIError {
    struct Envelope: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }
    let detail = try? JSONDecoder().decode(Envelope.self, from: data).error
    return ChatbotAPIError(status: status, code: detail?.code ?? "http_error", message: detail?.message ?? "Request failed (\(status)). Refresh before retrying.")
}
