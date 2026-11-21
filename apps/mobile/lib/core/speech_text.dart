/// v1.12 (docs/30): text for the on-device voice.
///
/// [SpeechChunker] cuts a reply that is still streaming into pieces the voice can say one after
/// another: the first piece is short so speech starts quickly, later ones are whole sentences.
/// It never waits for the full reply. [normalizeForSpeech] turns written text into words a speech
/// model says correctly (amounts in pesos, dates, percentages, common abbreviations, no markdown).
library;

const _abbrev = {
  'mr', 'mrs', 'ms', 'dr', 'st', 'sr', 'jr', 'prof', 'sen', 'rep', 'gov', 'atty', 'engr', 'hon', 'gen', 'col', 'capt', 'lt', 'sgt', //
  'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie', 'vol', 'approx', 'dept', 'inc', 'ltd', 'corp', 'ave', 'blvd', 'brgy', //
  'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'tue', 'tues', 'thu', 'thur', 'thurs', 'fri', //
  'a.m', 'p.m', 'u.s',
};

/// Splits streamed text into speakable chunks in order, with nothing lost or repeated.
class SpeechChunker {
  SpeechChunker({this.firstMinWords = 4, this.firstMaxWords = 10, this.maxWords = 18});

  /// The first chunk may end at a comma once it has this many words, and is cut at [firstMaxWords].
  final int firstMinWords, firstMaxWords;

  /// Later chunks end at sentences; a very long sentence is cut at a pause after this many words.
  final int maxWords;

  String _buf = '';
  int _emitted = 0;

  /// How many chunks came out so far.
  int get count => _emitted;

  /// Feeds the next streamed piece; returns the chunks that are now complete.
  List<String> add(String delta) {
    _buf += delta;
    final out = <String>[];
    while (true) {
      final cut = _nextCut();
      if (cut <= 0) break;
      final piece = _buf.substring(0, cut).trim();
      _buf = _buf.substring(cut);
      if (piece.isNotEmpty && _hasWords(piece)) {
        out.add(piece);
        _emitted++;
      } else if (piece.isNotEmpty) {
        _buf = '$piece $_buf'; // punctuation only: keep it with the next words
        break;
      }
    }
    return out;
  }

  /// The reply ended (or a tool started): whatever is left is the last chunk.
  List<String> finish() {
    final rest = _buf.trim();
    _buf = '';
    if (rest.isEmpty || !_hasWords(rest)) return const [];
    _emitted++;
    return [rest];
  }

  /// Drops everything not yet spoken (barge-in, cancel).
  void reset() {
    _buf = '';
    _emitted = 0;
  }

  static bool _hasWords(String s) => RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(s);

  static int _words(String s) => s.trim().isEmpty ? 0 : s.trim().split(RegExp(r'\s+')).length;

  /// Index just after the end of the next complete chunk in [_buf], or 0 when none is ready yet.
  int _nextCut() {
    final b = _buf;
    final first = _emitted == 0;
    int? clause;
    for (var i = 0; i < b.length; i++) {
      final c = b[i];
      // A boundary only counts once the next character is known (a "4." could still become "4.5").
      if (i + 1 >= b.length) break;
      final next = b[i + 1];
      if (c == '\n') {
        if (_hasWords(b.substring(0, i))) return i + 1;
        continue;
      }
      final ws = next == ' ' || next == '\n' || next == '\t';
      if ('.!?…'.contains(c)) {
        var j = i + 1;
        while (j < b.length && '.!?…"\')”’'.contains(b[j])) {
          j++;
        }
        if (j >= b.length) break; // "?!" or a closing quote may still follow
        if (!' \n\t'.contains(b[j])) continue;
        if (c == '.' && _isAbbrev(b, i)) continue;
        return j;
      }
      if (ws && ',;:—–'.contains(c)) {
        final before = b.substring(0, i + 1);
        final n = _words(before);
        if (first && n >= firstMinWords) return i + 1;
        if (!first && n >= maxWords) clause ??= i + 1;
      }
    }
    if (clause != null) return clause;
    // No boundary yet: cut a run-on at the cap, at the last space before the newest (maybe unfinished) word.
    final cap = first ? firstMaxWords : maxWords + 8;
    if (_words(b) > cap) {
      final words = RegExp(r'\S+\s+').allMatches(b).toList();
      if (words.length >= cap) return words[cap - 1].end;
    }
    return 0;
  }

  /// True when the period at [dot] belongs to an abbreviation, an initial or a number ("Dr.", "J.", "3.").
  static bool _isAbbrev(String b, int dot) {
    var s = dot;
    while (s > 0 && !' \n\t("'.contains(b[s - 1])) {
      s--;
    }
    final word = b.substring(s, dot).toLowerCase();
    if (word.isEmpty) return false;
    if (_abbrev.contains(word)) return true;
    if (RegExp(r'^[a-z]$').hasMatch(word)) return true; // an initial: "J. Reyes"
    if (RegExp(r'^([a-z]\.)+[a-z]$').hasMatch(word)) return true; // "e.g", "p.m"
    // A list number at the start ("1. Call Ana") is not a sentence end.
    if (RegExp(r'^\d{1,2}$').hasMatch(word) && (s == 0 || b[s - 1] == '\n')) return true;
    return false;
  }
}

// ---- Normalising -------------------------------------------------------------------------------------

const _ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const _tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const _scales = [(1000000000000, 'trillion'), (1000000000, 'billion'), (1000000, 'million'), (1000, 'thousand')];

/// 1234 → "one thousand two hundred thirty-four".
String numberWords(int n) {
  if (n < 0) return 'minus ${numberWords(-n)}';
  if (n < 20) return _ones[n];
  if (n < 100) return _tens[n ~/ 10] + (n % 10 == 0 ? '' : '-${_ones[n % 10]}');
  if (n < 1000) return '${_ones[n ~/ 100]} hundred${n % 100 == 0 ? '' : ' ${numberWords(n % 100)}'}';
  for (final (v, name) in _scales) {
    if (n >= v) return '${numberWords(n ~/ v)} $name${n % v == 0 ? '' : ' ${numberWords(n % v)}'}';
  }
  return '$n';
}

/// 28 → "twenty-eighth".
String ordinalWords(int n) {
  final w = numberWords(n);
  const irregular = {'one': 'first', 'two': 'second', 'three': 'third', 'five': 'fifth', 'eight': 'eighth', 'nine': 'ninth', 'twelve': 'twelfth'};
  final m = RegExp(r'([a-z]+)$').firstMatch(w)!;
  final last = m.group(1)!;
  final head = w.substring(0, m.start);
  if (irregular.containsKey(last)) return head + irregular[last]!;
  if (last.endsWith('y')) return '$head${last.substring(0, last.length - 1)}ieth';
  return '$head${last}th';
}

/// 2026 → "twenty twenty-six"; 2005 → "two thousand five"; 1990 → "nineteen ninety".
String yearWords(int y) {
  if (y >= 2000 && y < 2010) return numberWords(y);
  if (y % 100 == 0) return '${numberWords(y ~/ 100)} hundred';
  final lo = y % 100;
  return '${numberWords(y ~/ 100)} ${lo < 10 ? 'oh ${_ones[lo]}' : numberWords(lo)}';
}

/// "4,250.75" → "four thousand two hundred fifty point seven five".
String decimalWords(String s) {
  final clean = s.replaceAll(',', '');
  final parts = clean.split('.');
  final whole = int.tryParse(parts[0].isEmpty ? '0' : parts[0]);
  if (whole == null) return s;
  if (parts.length < 2 || parts[1].isEmpty) return numberWords(whole);
  return '${numberWords(whole)} point ${parts[1].split('').map((d) => _ones[int.parse(d)]).join(' ')}';
}

String _money(String amount, String unit, String sub) {
  final clean = amount.replaceAll(',', '');
  final parts = clean.split('.');
  final whole = int.tryParse(parts[0].isEmpty ? '0' : parts[0]) ?? 0;
  var cents = 0;
  if (parts.length > 1 && parts[1].isNotEmpty) cents = int.parse(parts[1].padRight(2, '0').substring(0, 2));
  final w = '${numberWords(whole)} ${whole == 1 ? unit : '${unit}s'}';
  if (cents == 0) return w;
  return '$w and ${numberWords(cents)} ${cents == 1 ? sub : '${sub}s'}';
}

const _months = {
  'jan': 'January', 'feb': 'February', 'mar': 'March', 'apr': 'April', 'may': 'May', 'jun': 'June', 'jul': 'July', //
  'aug': 'August', 'sep': 'September', 'sept': 'September', 'oct': 'October', 'nov': 'November', 'dec': 'December',
};
const _monthNames = 'January|February|March|April|May|June|July|August|September|October|November|December';

final _emoji = RegExp(r'[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]', unicode: true);

/// Written text → what the voice should say. Safe to call on any chunk.
String normalizeForSpeech(String input) {
  var s = input;
  // Markdown and links.
  s = s.replaceAllMapped(RegExp(r'!?\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!);
  s = s.replaceAll(RegExp(r'https?://\S+|www\.\S+'), 'the link');
  s = s.replaceAll(RegExp(r'```[\s\S]*?```'), ' ');
  s = s.replaceAll(RegExp(r'[`*_~]{1,3}'), '');
  s = s.replaceAll(RegExp(r'^\s{0,3}#{1,6}\s*', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^\s*([-•*+]|\d{1,2}[.)])\s+', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^\s*>\s?', multiLine: true), '');
  s = s.replaceAll(_emoji, '');
  s = s.replaceAll(RegExp(r'\s*\|\s*'), ', ');

  // Names Qline cares about.
  s = s.replaceAll(RegExp(r'\bQline\b', caseSensitive: false), 'Q line');
  s = s.replaceAll(RegExp(r'\bGCash\b'), 'G Cash');

  // Money: ₱1,250.50, PHP 1,250, P1,250, $12.50.
  const amt = r'(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)';
  s = s.replaceAllMapped(RegExp('(?:₱|\\bPHP\\s?|\\bPhp\\s?|\\bP(?=\\d))$amt(\\s?(?:k|K|M)\\b)?'), (m) => _scaled(m[1]!, m[2], 'peso', 'centavo'));
  s = s.replaceAllMapped(RegExp('(?:\\\$|\\bUSD\\s?)$amt(\\s?(?:k|K|M)\\b)?'), (m) => _scaled(m[1]!, m[2], 'dollar', 'cent'));
  s = s.replaceAllMapped(RegExp('$amt\\s?(?:pesos|PHP)\\b'), (m) => _money(m[1]!, 'peso', 'centavo'));

  // Percentages.
  s = s.replaceAllMapped(RegExp(r'(\d+(?:\.\d+)?)\s?%'), (m) => '${decimalWords(m[1]!)} percent');

  // Dates: "Nov. 28", "November 28, 2026", "28 Nov".
  s = s.replaceAllMapped(RegExp(r'\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?(?=\s+\d)'), (m) => _months[m[1]!.toLowerCase()]!);
  s = s.replaceAllMapped(RegExp('\\b($_monthNames)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(,?\\s+(\\d{4})\\b)?'), (m) {
    final day = int.parse(m[2]!);
    final year = m[4] != null ? ' ${yearWords(int.parse(m[4]!))}' : '';
    return day >= 1 && day <= 31 ? '${m[1]} ${ordinalWords(day)}$year' : m[0]!;
  });
  s = s.replaceAllMapped(RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+($_monthNames)\\b'), (m) => 'the ${ordinalWords(int.parse(m[1]!))} of ${m[2]}');
  s = s.replaceAllMapped(RegExp(r'\b(\d{4})-(\d{2})-(\d{2})\b'), (m) {
    final mo = int.parse(m[2]!), d = int.parse(m[3]!);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return m[0]!;
    return '${_monthNames.split('|')[mo - 1]} ${ordinalWords(d)} ${yearWords(int.parse(m[1]!))}';
  });

  // Times: "3:30 PM", "10:00".
  s = s.replaceAllMapped(RegExp(r'\b(\d{1,2}):(\d{2})\s?([AaPp])\.?\s?[Mm]\.?(?=\W|$)'), (m) => '${_clock(m[1]!, m[2]!)} ${m[3]!.toLowerCase() == 'a' ? 'A M' : 'P M'}');
  s = s.replaceAllMapped(RegExp(r'\b(\d{1,2})\s?([AaPp])\.?[Mm]\.?(?=\W|$)'), (m) => '${numberWords(int.parse(m[1]!))} ${m[2]!.toLowerCase() == 'a' ? 'A M' : 'P M'}');
  s = s.replaceAllMapped(RegExp(r'\b(\d{1,2}):(\d{2})\b'), (m) => _clock(m[1]!, m[2]!));

  // Abbreviations.
  const words = {
    r'\be\.g\.,?': 'for example', r'\bi\.e\.,?': 'that is', r'\betc\.': 'et cetera', r'\bvs\.?(?=\s)': 'versus', r'\bapprox\.': 'about', //
    r'\bDr\.(?=\s)': 'Doctor', r'\bMr\.(?=\s)': 'Mister', r'\bMrs\.(?=\s)': 'Missus', r'\bAtty\.(?=\s)': 'Attorney', r'\bEngr\.(?=\s)': 'Engineer', //
    r'\bSt\.(?=\s+[A-Z])': 'Saint', r'\bBrgy\.(?=\s)': 'Barangay', r'\bNo\.\s?(?=\d)': 'number ', r'\bw/(?=\s)': 'with',
  };
  for (final e in words.entries) {
    s = s.replaceAll(RegExp(e.key), e.value);
  }
  s = s.replaceAll(RegExp(r'\s&\s'), ' and ');
  s = s.replaceAllMapped(RegExp(r'(\d)\s?[x×]\s?(\d)'), (m) => '${m[1]} by ${m[2]}');
  s = s.replaceAllMapped(RegExp(r'(?<![\d-])(\d{1,4})\s?[–-]\s?(\d{1,4})(?![\d-])'), (m) => '${m[1]} to ${m[2]}');

  // Ordinals and remaining numbers.
  s = s.replaceAllMapped(RegExp(r'\b(\d+)(st|nd|rd|th)\b'), (m) => ordinalWords(int.parse(m[1]!)));
  s = s.replaceAllMapped(RegExp(r'(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?![\d])'), (m) {
    final t = m[1]!;
    if (!t.contains(',') && !t.contains('.') && t.length >= 7) return t.split('').map((d) => _ones[int.parse(d)]).join(' '); // phone numbers, codes
    if (!t.contains(',') && !t.contains('.') && t.length == 4) {
      final y = int.parse(t);
      if (y >= 1900 && y < 2100) return yearWords(y);
    }
    return decimalWords(t);
  });

  s = s.replaceAll(RegExp(r'[ \t]+'), ' ').replaceAll(RegExp(r'\s*\n\s*'), ' ').trim();
  return s;
}

String _scaled(String amount, String? suffix, String unit, String sub) {
  final sfx = suffix?.trim().toLowerCase();
  if (sfx == 'k' || sfx == 'm') return '${decimalWords(amount)} ${sfx == 'k' ? 'thousand' : 'million'} ${unit}s';
  return _money(amount, unit, sub);
}

String _clock(String h, String m) {
  final hh = int.parse(h), mm = int.parse(m);
  if (mm == 0) return "${numberWords(hh)} o'clock";
  return '${numberWords(hh)} ${mm < 10 ? 'oh ${_ones[mm]}' : numberWords(mm)}';
}
