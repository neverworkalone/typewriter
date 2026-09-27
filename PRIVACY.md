# Typewriter Chrome extension privacy disclosure

This disclosure describes the current Typewriter Chrome extension package.

## Data stored on this device

The extension saves the preferences explicitly saved from its Settings page in
`chrome.storage.local` for this Chrome profile. Search text and dictionary results
are used in memory to look up entries in the packaged `dictionary.sqlite` file.
The extension does not keep a search history or save search text and results.

## Data sent from the extension

The extension does not send search text, results, or saved preferences to a
Typewriter server or another external service. Dictionary lookup reads the
database packaged with the extension from the extension's own local origin. The
extension does not use analytics, accounts, cookies, or remote dictionary APIs.

## Permissions

The manifest requests the Chrome `storage` permission for saved Settings. It does
not request host access, optional permissions, or access to visited pages. Its
extension-page content security policy permits packaged code and the WebAssembly
evaluation needed by the local SQLite runtime.

This disclosure applies to the extension behavior and permissions in the package
that ships it. Update this text when those behaviors or permissions change.
