import Foundation
import Security

public protocol CredentialStore: Sendable {
    func load() throws -> Data?
    func save(_ data: Data) throws
    func remove() throws
}
/// Tokens stay in this app's non-migrating device Keychain, never UserDefaults or a source file.
public final class KeychainCredentials: CredentialStore, @unchecked Sendable {
    private let service: String
    public init(service: String) { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "chatbot-session", kSecUseDataProtectionKeychain as String: true]
    }
    public func load() throws -> Data? {
        var query = self.query
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        return result as? Data
    }
    public func save(_ data: Data) throws {
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try check(SecItemAdd(attributes as CFDictionary, nil))
        } else { try check(status) }
    }
    public func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }
    private func check(_ status: OSStatus) throws {
        if status != errSecSuccess { throw ChatbotAPIError(status: 0, code: "keychain", message: "Secure session storage is unavailable (\(status)).") }
    }
}
