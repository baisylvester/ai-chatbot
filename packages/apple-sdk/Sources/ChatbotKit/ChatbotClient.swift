import Foundation

/// Native HTTP client. Every request uses a verified USER token; no widget or organization keys.
public actor ChatbotClient {
    private let base: URL
    private let token: @Sendable () async throws -> String
    private let transport: HTTPTransport
    public init(baseURL: URL, accessToken: @escaping @Sendable () async throws -> String, transport: @escaping HTTPTransport = ephemeralTransport()) throws {
        try validateBase(baseURL)
        self.base = baseURL.appendingPathComponent("api/v1/client")
        self.token = accessToken; self.transport = transport
    }
    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var components = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await transport(request)
        guard (200..<300).contains(response.statusCode) else { throw apiFailure(data, status: response.statusCode) }
        return data
    }
    public func config(chatbotId: String) async throws -> BotConfig {
        guard chatbotId.range(of: "^cb_[A-Za-z0-9]{16,64}$", options: .regularExpression) != nil else {
            throw ChatbotAPIError(status: 0, code: "configuration", message: "Set a valid public chatbot ID.")
        }
        return try JSONDecoder().decode(BotConfig.self, from: await request("chatbots/\(chatbotId)"))
    }
    public func conversations(chatbotId: String, before: String? = nil) async throws -> ConversationPage {
        var query = [URLQueryItem(name: "chatbotId", value: chatbotId)]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try JSONDecoder().decode(ConversationPage.self, from: await request("conversations", query: query))
    }
    /// Retain the id on uncertain retries. Creation is idempotent.
    public func createConversation(chatbotId: String, id: UUID = UUID()) async throws -> Conversation {
        struct Body: Encodable { let id: UUID; let chatbotId: String }
        let body = try JSONEncoder().encode(Body(id: id, chatbotId: chatbotId))
        return try JSONDecoder().decode(Conversation.self, from: await request("conversations", method: "POST", body: body))
    }
    public func messages(conversationId: UUID, after: String = "0") async throws -> MessagePage {
        try JSONDecoder().decode(MessagePage.self, from: await request("conversations/\(conversationId.uuidString)/messages", query: [URLQueryItem(name: "after", value: after)]))
    }
    /// No automatic retry: the request may have been accepted even when the connection drops.
    public func send(conversationId: UUID, requestId: UUID, message: String) async throws -> Turn {
        struct Body: Encodable { let requestId: UUID; let message: String; let stream = false }
        struct Envelope: Decodable { let turn: Turn }
        let body = try JSONEncoder().encode(Body(requestId: requestId, message: message))
        let turn = try JSONDecoder().decode(Envelope.self, from: await request("conversations/\(conversationId.uuidString)/messages", method: "POST", body: body)).turn
        guard turn.requestId == requestId, turn.status != .running else {
            throw ChatbotAPIError(status: 0, code: "protocol_error", message: "Invalid completion. Refresh the conversation.")
        }
        return turn
    }
    public func deleteConversation(_ id: UUID) async throws {
        _ = try await request("conversations/\(id.uuidString)", method: "DELETE")
    }
}
