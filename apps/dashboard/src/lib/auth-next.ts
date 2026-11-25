/** Only a known first-party chat path may override the default post-login destination. */
export function authNext(value: unknown): string {
  return typeof value === "string" && /^\/chat\/cb_[A-Za-z0-9]{16,64}$/.test(value) ? value : "/orgs";
}
