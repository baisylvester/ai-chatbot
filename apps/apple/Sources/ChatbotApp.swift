import SwiftUI
import ChatbotKit

@MainActor @main struct ChatbotApp: App {
    @StateObject private var model = ChatModel()
    var body: some Scene { WindowGroup { ChatView(model: model) } }
}
@MainActor private struct ChatView: View {
    @ObservedObject var model: ChatModel
    @Environment(\.scenePhase) private var phase
    @State private var deleting = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if model.starting { ProgressView("Restoring sign-in…") }
                else if !model.configured { Text(model.error ?? "Configure the app's server settings.").padding() }
                else if model.user == nil { signIn }
                else { chat }
            }
            .padding()
            .frame(maxWidth: 840)
            .navigationTitle(model.config?.name ?? "Chatbot")
            .toolbar {
                if model.user != nil {
                    Button("Refresh") { Task { await model.refresh() } }
                    Button("Sign out") { Task { await model.signOut() } }
                }
            }
        }
        .task { await model.start() }
        .task(id: model.user?.id) {
            while model.user != nil && !Task.isCancelled {
                if phase == .active { await model.refresh() }
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .onChange(of: phase) { value in if value == .active { Task { await model.refresh() } } }
    }
    private var signIn: some View {
        VStack(spacing: 12) {
            Text("Use the same account as your web and Android apps.").font(.subheadline)
            TextField("Email", text: $model.email).emailInput().textFieldStyle(.roundedBorder)
            SecureField("Password", text: $model.password).textFieldStyle(.roundedBorder)
            if let error = model.error { Text(error).foregroundStyle(.red).font(.caption) }
            Button("Sign in") { Task { await model.signIn() } }.buttonStyle(.borderedProminent).disabled(model.busy || model.email.isEmpty || model.password.isEmpty)
            if let url = model.platformURL { Link("Create an account on the website", destination: url.appendingPathComponent("auth/sign-up")) }
        }.frame(maxWidth: 400)
    }
    private var chat: some View {
        VStack(spacing: 12) {
            HStack {
                Picker("Conversation", selection: Binding(get: { model.selected }, set: { model.select($0) })) {
                    Text("New conversation").tag(nil as UUID?)
                    if let selected = model.selected, !model.conversations.contains(where: { $0.id == selected }) { Text("Current conversation").tag(selected as UUID?) }
                    ForEach(model.conversations) { Text($0.title).tag($0.id as UUID?) }
                }.disabled(model.busy)
                Button("New chat") { Task { await model.newConversation() } }.disabled(model.busy)
                Button("Delete", role: .destructive) { deleting = true }.disabled(model.selected == nil || model.busy)
            }
            if model.more != nil { Button("Load older conversations") { Task { await model.loadOlder() } } }
            Text("Private to your account · Synced across devices").font(.caption).foregroundStyle(.secondary)
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.messages) { message in
                            HStack {
                                if message.role == "user" { Spacer(minLength: 40) }
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(message.text).textSelection(.enabled)
                                    if !message.citations.isEmpty {
                                        DisclosureGroup("Sources (\(message.citations.count))") {
                                            ForEach(message.citations, id: \.n) { citation in Text("[\(citation.n)] \(citation.title): \(citation.snippet)").font(.caption) }
                                        }
                                    }
                                }.padding(12).background(message.role == "user" ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.1)).clipShape(RoundedRectangle(cornerRadius: 12))
                                if message.role != "user" { Spacer(minLength: 40) }
                            }.id(message.id)
                        }
                        if model.busy || model.running { ProgressView("Waiting for the saved reply…") }
                    }
                }.onChange(of: model.messages.count) { _ in if let id = model.messages.last?.id { scroll.scrollTo(id, anchor: .bottom) } }
            }
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom) {
                TextField("Message", text: $model.input, axis: .vertical).lineLimit(2...5).textFieldStyle(.roundedBorder).disabled(model.busy)
                Button("Send") { Task { await model.send() } }.buttonStyle(.borderedProminent).disabled(model.busy || model.running || model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.input.utf16.count > 4000)
            }
        }.confirmationDialog("Delete this conversation on all devices?", isPresented: $deleting) {
            Button("Delete conversation", role: .destructive) { Task { await model.deleteConversation() } }
        }
    }
}
private extension View {
    @ViewBuilder func emailInput() -> some View {
        #if os(iOS)
        self.keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        self.autocorrectionDisabled()
        #endif
    }
}
