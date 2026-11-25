import XCTest
import Foundation
@testable import ChatbotKit

private actor Recorder {
    var requests: [URLRequest] = []
    let response: Data
    let status: Int
    init(_ json: String, status: Int = 200) { self.response = Data(json.utf8); self.status = status }
    func send(_ request: URLRequest) -> (Data, HTTPURLResponse) {
        requests.append(request)
        return (response, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
private final class MemoryCredentials: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?
    func load() -> Data? { lock.lock(); defer { lock.unlock() }; return value }
    func save(_ data: Data) { lock.lock(); defer { lock.unlock() }; value = data }
    func remove() { lock.lock(); defer { lock.unlock() }; value = nil }
}

final class ClientTests: XCTestCase {
    func testListUsesUserTokenAndEscapesCursor() async throws {
        let recorder = Recorder(#"{"conversations":[],"nextCursor":null}"#)
        let client = try ChatbotClient(baseURL: URL(string: "https://platform.example")!, accessToken: { "user-token" }, transport: { await recorder.send($0) })
        _ = try await client.conversations(chatbotId: "cb_abcdefghijklmnop", before: "2026-11-17T00:00:00.000Z|id")
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer user-token")
        XCTAssertEqual(requests[0].url?.path, "/api/v1/client/conversations")
        XCTAssertEqual(URLComponents(url: requests[0].url!, resolvingAgainstBaseURL: false)?.queryItems?.last?.value, "2026-11-17T00:00:00.000Z|id")
    }
    func testConflictDoesNotRetryOrCreateAnotherRequest() async throws {
        let recorder = Recorder(#"{"error":{"code":"conflict","message":"Another reply is running"}}"#, status: 409)
        let client = try ChatbotClient(baseURL: URL(string: "https://platform.example")!, accessToken: { "token" }, transport: { await recorder.send($0) })
        let request = UUID()
        do { _ = try await client.send(conversationId: UUID(), requestId: request, message: "Hello"); XCTFail("Expected conflict") }
        catch let error as ChatbotAPIError { XCTAssertEqual(error.status, 409) }
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
        let body = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! [String: Any]
        XCTAssertEqual(body["requestId"] as? String, request.uuidString)
    }
    func testMessageCursorIsDecodedWithoutFloatingPointLoss() throws {
        let json = #"{"conversation":{"id":"00000000-0000-4000-8000-000000000001","chatbotId":"cb_abcdefghijklmnop","title":"Test","createdAt":"2026-11-17T00:00:00Z","updatedAt":"2026-11-17T00:00:00Z","revision":"9007199254740993","lastTurn":null},"messages":[],"nextCursor":"9007199254740993","hasMore":false}"#
        let page = try JSONDecoder().decode(MessagePage.self, from: Data(json.utf8))
        XCTAssertEqual(page.nextCursor, "9007199254740993")
    }
    func testRefusesSendingCredentialsOverPublicHTTP() {
        XCTAssertThrowsError(try ChatbotClient(baseURL: URL(string: "http://platform.example")!, accessToken: { "token" }))
        XCTAssertNoThrow(try ChatbotClient(baseURL: URL(string: "http://127.0.0.1:3100")!, accessToken: { "token" }))
    }
    func testAuthPersistsAndRestoresTheSameAccountWithoutAnotherPasswordRequest() async throws {
        let recorder = Recorder(#"{"access_token":"access","refresh_token":"refresh","expires_in":3600,"user":{"id":"00000000-0000-4000-8000-000000000001","email":"user@example.test"}}"#)
        let storage = MemoryCredentials()
        let auth = try SupabaseAuth(url: URL(string: "https://auth.example")!, publishableKey: "public-key", store: storage, transport: { await recorder.send($0) })
        let first = try await auth.signIn(email: "user@example.test", password: "password")
        let restored = try SupabaseAuth(url: URL(string: "https://auth.example")!, publishableKey: "public-key", store: storage, transport: { await recorder.send($0) })
        let second = try await restored.restore()
        XCTAssertEqual(first.id, second?.id)
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "apikey"), "public-key")
        try await restored.signOut()
        XCTAssertNil(storage.load())
    }
}
