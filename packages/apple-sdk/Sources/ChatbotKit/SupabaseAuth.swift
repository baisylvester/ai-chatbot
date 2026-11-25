import Foundation

/// Email/password auth for the same Supabase project used by the web app.
/// Native sessions are per-device; the server derives conversation ownership from the verified sub.
public actor SupabaseAuth {
    private struct Session: Codable, Sendable { let access: String; let refresh: String; let expires: Date; let user: AuthIdentity }
    private struct Tokens: Decodable {
        let access_token: String; let refresh_token: String; let expires_in: Double; let user: AuthIdentity
        var session: Session { Session(access: access_token, refresh: refresh_token, expires: Date().addingTimeInterval(expires_in), user: user) }
    }
    private let base: URL
    private let key: String
    private let store: any CredentialStore
    private let transport: HTTPTransport
    private var session: Session?
    private var refresh: Task<Session, Error>?
    private var generation = UUID()
    public init(url: URL, publishableKey: String, store: any CredentialStore, transport: @escaping HTTPTransport = ephemeralTransport()) throws {
        try validateBase(url)
        self.base = url.appendingPathComponent("auth/v1"); self.key = publishableKey; self.store = store; self.transport = transport
    }
    private func exchange(_ grant: String, values: [String: String]) async throws -> Session {
        var components = URLComponents(url: base.appendingPathComponent("token"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: grant)]
        var request = URLRequest(url: components.url!); request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(values)
        let (data, response) = try await transport(request)
        guard (200..<300).contains(response.statusCode) else {
            throw ChatbotAPIError(status: response.statusCode, code: "sign_in", message: grant == "password" ? "Could not sign in. Check your email, password and email confirmation." : "Your sign-in expired. Sign in again.")
        }
        return try JSONDecoder().decode(Tokens.self, from: data).session
    }
    public func signIn(email: String, password: String) async throws -> AuthIdentity {
        generation = UUID(); let current = generation
        refresh?.cancel(); refresh = nil
        let next = try await exchange("password", values: ["email": email, "password": password])
        guard generation == current else { throw CancellationError() }
        try store.save(JSONEncoder().encode(next)); session = next
        return next.user
    }
    public func restore() async throws -> AuthIdentity? {
        if session == nil, let data = try store.load() { session = try JSONDecoder().decode(Session.self, from: data) }
        guard session != nil else { return nil }
        _ = try await accessToken()
        return session?.user
    }
    public func accessToken() async throws -> String {
        guard let saved = session else { throw ChatbotAPIError(status: 401, code: "unauthorized", message: "Sign in to continue.") }
        if saved.expires > Date().addingTimeInterval(60) { return saved.access }
        let current = generation
        let task: Task<Session, Error>
        if let refresh { task = refresh }
        else {
            task = Task { try await self.exchange("refresh_token", values: ["refresh_token": saved.refresh]) }
            refresh = task
        }
        do {
            let next = try await task.value
            guard generation == current else { throw CancellationError() }
            try store.save(JSONEncoder().encode(next)); session = next; refresh = nil
            return next.access
        } catch {
            if generation == current {
                refresh = nil
                if let failure = error as? ChatbotAPIError, [400, 401, 403].contains(failure.status) {
                    session = nil; try store.remove()
                }
            }
            throw error
        }
    }
    public func signOut() async throws {
        let token = session?.access
        generation = UUID(); refresh?.cancel(); refresh = nil; session = nil
        try store.remove()
        if let token {
            var request = URLRequest(url: base.appendingPathComponent("logout").appending(queryItems: [URLQueryItem(name: "scope", value: "local")]))
            request.httpMethod = "POST"; request.setValue(key, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await transport(request)
        }
    }
}
