# Native iOS and macOS clients

Shared SwiftUI interface with separate iOS 17+ and macOS 14+ application targets. Both use `packages/apple-sdk` (ChatbotKit), the same Supabase account and the new `/api/v1/client` API. There are no third-party Swift dependencies.

Implemented: email/password sign-in, non-migrating Keychain session storage, access-token refresh, private conversation selection/creation/deletion, message pagination, stable send request IDs, five-second foreground sync and foreground refresh. The JSON send displays a waiting indicator until the reply is saved. Voice, an offline outbox and App Store packaging are outside this first text-chat milestone.

## Build on a Mac

1. Apply the backend migration and deploy the backend described in `../../docs/CLIENT_API.md`.
2. Copy `Configuration.xcconfig.example` to `Configuration.xcconfig` and set the public platform URL, active `cb_…` chatbot ID, Supabase project URL and publishable key. Never enter a service-role or organization API key. Use the SAME values/account as Android and web.
3. Generate `Chatbot.xcodeproj` from `project.yml` with XcodeGen: `xcodegen generate` from this directory. The `.xcconfig` example preserves URL slashes using `$()` because Xcode otherwise reads `//` as a comment.
4. Open the generated project in Xcode, select `Chatbot-iOS` or `Chatbot-macOS`, choose your signing team and run. Set the deployment targets to at least iOS 17/macOS 14 as declared in the spec. The macOS entitlement permits outgoing network access inside the sandbox.
5. Use an existing confirmed account or create one through the website link, then sign in. Verify a message sent on web appears here, reply here and verify it appears on web/Android.

Run SDK tests with `swift test --package-path ../../packages/apple-sdk`. CI also type-checks the shared macOS SwiftUI sources. Apple compilation, signing and actual device behavior cannot be verified on the Windows development host; do not treat source generation as a validated native release.

Tokens stay in Keychain. Only an account/platform/chatbot-scoped conversation UUID is stored in UserDefaults. Messages are recovered from the server on launch; this version has no persistent offline transcript cache. Separate native app installations have separate sign-in tokens but share conversation data through the backend.
