import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// M2 (docs/18): reopening the AI chat continues the conversation you were in, instead of starting a new one.
///
/// The app remembers one pointer per account and organisation: the id of the conversation last open, or
/// [newChatPointer] after you tapped New chat (so a fresh, still-empty chat is not replaced by an old one).
/// It holds no message content. All pointers are removed on sign-out.
const newChatPointer = 'new';
const _prefix = 'chat.current.';
const _draftPrefix = 'chat.draft.';

/// One key per organisation and account, so switching either never opens someone else's conversation.
String chatPointerKey(String orgId, String email) => '$_prefix$orgId.${email.trim().toLowerCase()}';

/// Personal AI OS phase 3: an unsent message is kept per account, organisation and conversation ([newChatPointer]
/// for a chat that has no id yet), in the same encrypted store as the pointer, and removed on send and sign-out.
String chatDraftKey(String orgId, String email, String? conversationId) => '$_draftPrefix$orgId.${email.trim().toLowerCase()}.${conversationId ?? newChatPointer}';

/// Drafts longer than this are cut (a draft is a note to self, not a document).
const maxDraftChars = 8000;

abstract class ChatPointerStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);

  /// Removes every chat pointer and draft (sign-out, session expired).
  Future<void> clearAll();
}

class SecureChatPointerStore implements ChatPointerStore {
  const SecureChatPointerStore([this._storage = const FlutterSecureStorage()]);
  final FlutterSecureStorage _storage;
  @override
  Future<String?> read(String key) => _storage.read(key: key);
  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _storage.delete(key: key);
  @override
  Future<void> clearAll() async {
    final all = await _storage.readAll();
    for (final k in all.keys.where((k) => k.startsWith(_prefix) || k.startsWith(_draftPrefix)).toList()) {
      await _storage.delete(key: k);
    }
  }
}

/// For tests.
class MemoryChatPointerStore implements ChatPointerStore {
  final Map<String, String> values = {};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
  @override
  Future<void> clearAll() async => values.removeWhere((k, _) => k.startsWith(_prefix) || k.startsWith(_draftPrefix));
}

final chatPointerStoreProvider = Provider<ChatPointerStore>((ref) => const SecureChatPointerStore());

class ChatResume {
  const ChatResume(this.conversationId, {this.note});

  /// The conversation to open, or null for a new, empty chat.
  final String? conversationId;

  /// Shown once when the remembered conversation could not be opened.
  final String? note;
}

/// Decides which conversation the chat opens with.
///
/// - [stored] is [newChatPointer]: the person started a new chat last time; keep it new.
/// - [stored] is an id: open it. [load] returns false when it no longer exists or is not theirs (404); then
///   fall back to their most recent conversation, with a note.
/// - nothing stored (first open, after sign-in): open their most recent conversation, if any.
/// Network errors from [load] or [latest] are not swallowed: the screen shows its usual retry.
Future<ChatResume> resolveConversation({required String? stored, required Future<bool> Function(String id) load, required Future<String?> Function() latest}) async {
  if (stored == newChatPointer) return const ChatResume(null);
  String? note;
  if (stored != null && stored.isNotEmpty) {
    if (await load(stored)) return ChatResume(stored);
    note = 'That conversation is no longer available.';
  }
  final recent = await latest();
  if (recent != null && recent != stored && await load(recent)) {
    return ChatResume(recent, note: note == null ? null : '$note Opened your most recent one.');
  }
  return ChatResume(null, note: note == null ? null : '$note Started a new chat.');
}
