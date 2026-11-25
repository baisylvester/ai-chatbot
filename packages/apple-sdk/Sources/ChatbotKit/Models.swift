import Foundation

public enum TurnStatus: String, Codable, Sendable { case running, completed, failed, interrupted }
public struct Citation: Codable, Sendable {
    public let n: Int
    public let title: String
    public let sourceUrl: String?
    public let snippet: String
}
public struct Turn: Codable, Sendable {
    public let requestId: UUID
    public let status: TurnStatus
    public let text: String
    public let citations: [Citation]
    public let error: String?
}
public struct Conversation: Codable, Identifiable, Sendable {
    public let id: UUID
    public let chatbotId: String
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    public let revision: String
    public let lastTurn: Turn?
}
public struct Message: Codable, Identifiable, Sendable {
    public let id: UUID
    public let role: String
    public let text: String
    public let citations: [Citation]
    public let sequence: String
    public let createdAt: String
    public let requestId: UUID?
    public let status: TurnStatus
}
public struct MessagePage: Codable, Sendable {
    public let conversation: Conversation
    public let messages: [Message]
    public let nextCursor: String
    public let hasMore: Bool
}
public struct ConversationPage: Codable, Sendable {
    public let conversations: [Conversation]
    public let nextCursor: String?
}
public struct BotConfig: Codable, Sendable {
    public let chatbotId: String
    public let name: String
    public let welcomeMessage: String
    public let suggestedQuestions: [String]
}
public struct AuthIdentity: Codable, Sendable {
    public let id: UUID
    public let email: String?
}
public struct ChatbotAPIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
    public init(status: Int, code: String, message: String) {
        self.status = status; self.code = code; self.message = message
    }
}
