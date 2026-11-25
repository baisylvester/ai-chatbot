import SwiftUI
import ChatbotKit

@MainActor final class ChatModel: ObservableObject {
    @Published var user: AuthIdentity?
    @Published var config: BotConfig?
    @Published var conversations: [Conversation] = []
    @Published var selected: UUID?
    @Published var messages: [Message] = []
    @Published var input = ""
    @Published var email = ""
    @Published var password = ""
    @Published var busy = false
    @Published var error: String?
    @Published var starting = true
    @Published var running = false
    @Published var more: String?
    let platformURL: URL?
    private let chatbotId: String
    private let auth: SupabaseAuth?
    private let client: ChatbotClient?
    private var cursor = "0"
    private var refreshing = false
    private var epoch = UUID()
    private var pending: (conversation: UUID, request: UUID, message: String)?
    private var creating: UUID?
    private var started = false
    private var listPages = 1
    var configured: Bool { client != nil }
    private var selectionKey: String { "chat:\(platformURL?.absoluteString ?? ""):\(chatbotId):\(user?.id.uuidString ?? "")" }

    init() {
        func value(_ key: String) -> String { Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "" }
        chatbotId = value("CHATBOT_PUBLIC_ID")
        platformURL = URL(string: value("CHATBOT_API_URL"))
        var configuredAuth: SupabaseAuth? = nil
        var configuredClient: ChatbotClient? = nil
        var setupError: String? = nil
        do {
            guard let base = platformURL, let url = URL(string: value("SUPABASE_URL")),
                  !value("SUPABASE_PUBLISHABLE_KEY").isEmpty, !value("SUPABASE_PUBLISHABLE_KEY").contains("replace"),
                  !chatbotId.contains("replace"), !base.absoluteString.contains("your-platform") else {
                throw ChatbotAPIError(status: 0, code: "configuration", message: "Set the public server, chatbot and Supabase settings in Configuration.xcconfig, then rebuild.")
            }
            let auth = try SupabaseAuth(url: url, publishableKey: value("SUPABASE_PUBLISHABLE_KEY"), store: KeychainCredentials(service: "chatbot:\(url.absoluteString)"))
            configuredClient = try ChatbotClient(baseURL: base, accessToken: { try await auth.accessToken() })
            configuredAuth = auth
        } catch { setupError = error.localizedDescription }
        self.auth = configuredAuth; self.client = configuredClient; self.error = setupError
    }
    func start() async {
        guard !started else { return }; started = true
        defer { starting = false }
        do { user = try await auth?.restore(); restoreSelection() }
        catch { self.error = error.localizedDescription }
    }
    func signIn() async {
        guard let auth, !busy else { return }
        busy = true; error = nil
        do { user = try await auth.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password); password = ""; epoch = UUID(); restoreSelection() }
        catch { self.error = error.localizedDescription }
        busy = false
    }
    func signOut() async {
        epoch = UUID(); user = nil; password = ""; conversations = []; messages = []; selected = nil
        pending = nil; creating = nil; cursor = "0"; config = nil; busy = false; running = false; input = ""; error = nil; listPages = 1
        do { try await auth?.signOut() } catch { self.error = error.localizedDescription }
    }
    private func restoreSelection() {
        selected = UserDefaults.standard.string(forKey: selectionKey).flatMap(UUID.init(uuidString:))
        cursor = "0"; messages = []
    }
    func select(_ id: UUID?) {
        guard !busy else { return }
        epoch = UUID(); selected = id; cursor = "0"; messages = []; pending = nil; running = false; error = nil
        UserDefaults.standard.set(id?.uuidString, forKey: selectionKey)
        Task { await refresh() }
    }
    func refresh() async {
        guard user != nil, let client, !busy, !refreshing else { return }
        refreshing = true; let current = epoch
        defer { refreshing = false }
        do {
            if config == nil {
                let value = try await client.config(chatbotId: chatbotId)
                guard current == epoch else { return }; config = value
            }
            var page = try await client.conversations(chatbotId: chatbotId)
            var snapshot = page.conversations
            if listPages > 1 {
                for _ in 1..<listPages {
                    guard let before = page.nextCursor else { break }
                    page = try await client.conversations(chatbotId: chatbotId, before: before)
                    snapshot.append(contentsOf: page.conversations)
                }
            }
            guard current == epoch else { return }
            conversations = snapshot; more = page.nextCursor
            if selected == nil { selected = conversations.first?.id }
            guard let id = selected else { return }
            for _ in 0..<100 {
                let page = try await client.messages(conversationId: id, after: cursor)
                guard current == epoch, selected == id else { return }
                let ids = Set(messages.map(\.id))
                messages.append(contentsOf: page.messages.filter { !ids.contains($0.id) })
                cursor = page.nextCursor; running = page.conversation.lastTurn?.status == .running
                error = page.conversation.lastTurn?.error
                if !page.hasMore { break }
            }
        } catch {
            guard current == epoch else { return }
            if let failure = error as? ChatbotAPIError, failure.status == 404 { selected = nil; messages = []; cursor = "0"; running = false }
            self.error = error.localizedDescription
        }
    }
    func loadOlder() async {
        guard let more, let client, !busy else { return }; let current = epoch
        do {
            let page = try await client.conversations(chatbotId: chatbotId, before: more)
            guard current == epoch else { return }
            let ids = Set(conversations.map(\.id)); conversations += page.conversations.filter { !ids.contains($0.id) }; self.more = page.nextCursor; listPages += 1
        } catch { if current == epoch { self.error = error.localizedDescription } }
    }
    func newConversation() async {
        guard let client, user != nil, !busy else { return }
        busy = true; let current = epoch; let id = creating ?? UUID(); creating = id
        defer { if current == epoch { busy = false } }
        do {
            let conversation = try await client.createConversation(chatbotId: chatbotId, id: id)
            guard current == epoch else { return }
            creating = nil; selected = id; cursor = "0"; messages = []; pending = nil; running = false; error = nil
            conversations.insert(conversation, at: 0); UserDefaults.standard.set(id.uuidString, forKey: selectionKey)
        } catch { if current == epoch { self.error = error.localizedDescription } }
    }
    func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, user != nil, !busy, !running, !text.isEmpty, text.utf16.count <= 4000 else { return }
        busy = true; error = nil; let current = epoch
        defer { if current == epoch { busy = false; Task { await refresh() } } }
        do {
            let id: UUID
            if let selected { id = selected }
            else {
                let creatingId = creating ?? UUID(); creating = creatingId
                let conversation = try await client.createConversation(chatbotId: chatbotId, id: creatingId)
                guard current == epoch else { return }
                creating = nil; id = conversation.id; selected = id; conversations.insert(conversation, at: 0)
                UserDefaults.standard.set(id.uuidString, forKey: selectionKey)
            }
            let request = pending?.conversation == id && pending?.message == text ? pending!.request : UUID()
            pending = (id, request, text)
            let turn = try await client.send(conversationId: id, requestId: request, message: text)
            guard current == epoch else { return }
            pending = nil; input = ""; error = turn.error
        } catch { if current == epoch { self.error = error.localizedDescription } }
    }
    func deleteConversation() async {
        guard let id = selected, let client, !busy else { return }; let current = epoch
        busy = true
        defer { if current == epoch { busy = false } }
        do {
            try await client.deleteConversation(id)
            guard current == epoch else { return }
            conversations.removeAll { $0.id == id }; selected = nil; messages = []; cursor = "0"; running = false; pending = nil
            UserDefaults.standard.removeObject(forKey: selectionKey)
        } catch { if current == epoch { self.error = error.localizedDescription } }
    }
}
