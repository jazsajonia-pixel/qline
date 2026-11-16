import 'package:material_ui/material_ui.dart';

/// Tokens from docs/03-DESIGN_SYSTEM.md §2.
@immutable
class QColors extends ThemeExtension<QColors> {
  const QColors({
    required this.bg,
    required this.surface1,
    required this.surface2,
    required this.line,
    required this.lineStrong,
    required this.text,
    required this.text2,
    required this.text3,
    required this.halo,
    required this.onHalo,
    required this.ok,
    required this.warn,
    required this.bad,
    required this.info,
  });
  final Color bg, surface1, surface2, line, lineStrong, text, text2, text3, halo, onHalo, ok, warn, bad, info;

  /// "Mint Signal on Violet Ink" (v1.2): violet-black ink surfaces, one mint signal accent.
  /// Deliberately distinct from FlowPilot (Cobalt Graphite) and Chrono (Ember on Ink).
  static const dark = QColors(
    bg: Color(0xFF0A0812),
    surface1: Color(0xFF12101B),
    surface2: Color(0xFF1B1826),
    line: Color(0xFF2A2638),
    lineStrong: Color(0xFF615A75),
    text: Color(0xFFEFECF6),
    text2: Color(0xFFB2ACC2),
    text3: Color(0xFF8D86A0),
    halo: Color(0xFF5EF2C6),
    onHalo: Color(0xFF03140E),
    ok: Color(0xFF9BE36D),
    warn: Color(0xFFFFC266),
    bad: Color(0xFFFF7A8A),
    info: Color(0xFF9DB8FF),
  );
  static const light = QColors(
    bg: Color(0xFFF6F4FA),
    surface1: Color(0xFFFFFFFF),
    surface2: Color(0xFFEDE9F4),
    line: Color(0xFFDDD7E8),
    lineStrong: Color(0xFF7D7590),
    text: Color(0xFF15121F),
    text2: Color(0xFF4A4459),
    text3: Color(0xFF625B71),
    halo: Color(0xFF087A5E),
    onHalo: Color(0xFFFFFFFF),
    ok: Color(0xFF2F7420),
    warn: Color(0xFF8A5A00),
    bad: Color(0xFFB3263E),
    info: Color(0xFF2C52B5),
  );

  @override
  QColors copyWith() => this;
  @override
  QColors lerp(ThemeExtension<QColors>? other, double t) => t < .5 ? this : (other as QColors? ?? this);
}

extension QTheme on BuildContext {
  QColors get q => Theme.of(this).extension<QColors>()!;
}

const ui = 'HankenGrotesk';
const mono = 'JetBrainsMono';

/// Variable fonts: set both weight and the wght axis.
TextStyle qs(double size, {FontWeight w = FontWeight.w400, Color? c, String family = ui, double? h, double? ls}) => TextStyle(
      fontFamily: family,
      fontSize: size,
      fontWeight: w,
      fontVariations: [FontVariation('wght', w.value.toDouble())],
      color: c,
      height: h ?? (size >= 18 ? 1.2 : 1.4),
      letterSpacing: ls,
    );

ThemeData buildTheme(bool light) {
  final c = light ? QColors.light : QColors.dark;
  final scheme = ColorScheme(
    brightness: light ? Brightness.light : Brightness.dark,
    primary: c.halo,
    onPrimary: c.onHalo,
    secondary: c.text2,
    onSecondary: c.bg,
    error: c.bad,
    onError: c.bg,
    surface: c.bg,
    onSurface: c.text,
    surfaceContainerHighest: c.surface2,
    outline: c.lineStrong,
    outlineVariant: c.line,
  );
  final text = TextTheme(
    displaySmall: qs(28, w: FontWeight.w600, c: c.text, ls: -0.4),
    headlineSmall: qs(22, w: FontWeight.w600, c: c.text, ls: -0.2),
    titleLarge: qs(22, w: FontWeight.w600, c: c.text),
    titleMedium: qs(18, w: FontWeight.w600, c: c.text),
    titleSmall: qs(16, w: FontWeight.w600, c: c.text),
    bodyLarge: qs(16, c: c.text),
    bodyMedium: qs(14, c: c.text),
    bodySmall: qs(12, c: c.text3),
    labelLarge: qs(14, w: FontWeight.w600, c: c.text),
    labelMedium: qs(12, w: FontWeight.w500, c: c.text2),
    labelSmall: qs(11, w: FontWeight.w500, c: c.text3),
  );
  OutlineInputBorder border(Color col, [double w = 1]) => OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: col, width: w));
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bg,
    fontFamily: ui,
    textTheme: text,
    extensions: [c],
    splashFactory: InkSparkle.splashFactory,
    dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
    appBarTheme: AppBarTheme(backgroundColor: c.bg, surfaceTintColor: Colors.transparent, elevation: 0, scrolledUnderElevation: 0, titleTextStyle: qs(18, w: FontWeight.w600, c: c.text), foregroundColor: c.text),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.surface2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: border(c.lineStrong),
      enabledBorder: border(c.lineStrong),
      focusedBorder: border(c.halo, 1.6),
      errorBorder: border(c.bad),
      focusedErrorBorder: border(c.bad, 1.6),
      labelStyle: qs(14, c: c.text2),
      hintStyle: qs(14, c: c.text3),
      helperStyle: qs(12, c: c.text3),
      errorStyle: qs(12, c: c.bad),
    ),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: c.surface1, surfaceTintColor: Colors.transparent, showDragHandle: true, dragHandleColor: c.lineStrong, shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(14)))),
    dialogTheme: DialogThemeData(backgroundColor: c.surface1, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
    snackBarTheme: SnackBarThemeData(backgroundColor: c.surface2, contentTextStyle: qs(14, c: c.text), behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: c.line))),
    chipTheme: ChipThemeData(backgroundColor: c.surface2, selectedColor: c.halo.withValues(alpha: .16), checkmarkColor: c.halo, secondarySelectedColor: c.halo.withValues(alpha: .16), side: BorderSide(color: c.line), labelStyle: qs(13, w: FontWeight.w500, c: c.text), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10))),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.onHalo : c.text2),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.halo : c.surface2),
      trackOutlineColor: WidgetStateProperty.all(c.lineStrong),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.halo, linearTrackColor: c.surface2),
    listTileTheme: ListTileThemeData(iconColor: c.text2, textColor: c.text, titleTextStyle: qs(15, w: FontWeight.w500, c: c.text), subtitleTextStyle: qs(13, c: c.text3), minVerticalPadding: 10),
    popupMenuTheme: PopupMenuThemeData(color: c.surface2, surfaceTintColor: Colors.transparent, textStyle: qs(14, c: c.text)),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {TargetPlatform.android: FadeForwardsPageTransitionsBuilder()}),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: c.halo, foregroundColor: c.onHalo)),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: c.surface1, indicatorColor: c.halo.withValues(alpha: .18), surfaceTintColor: Colors.transparent),
  );
}

/// Agent identity (docs/03 §2 "Agent identity").
class AgentStyle {
  const AgentStyle(this.hue, this.speed, this.curl, this.role);
  final Color hue;
  final double speed;
  final double curl;
  final String role;
  static const map = {
    'ceo': AgentStyle(Color(0xFFA58BFA), .55, 1.0, 'Chief of Staff'),
    'sales': AgentStyle(Color(0xFF2ED3EA), 1.25, .8, 'Pipeline & follow-ups'),
    'finance': AgentStyle(Color(0xFFF2B544), .75, .25, 'Cash flow & reports'),
    'operations': AgentStyle(Color(0xFF3FD39A), .9, .45, 'Projects & SOPs'),
    'marketing': AgentStyle(Color(0xFFF07AC0), 1.0, 1.6, 'Campaigns & content'),
    'research': AgentStyle(Color(0xFF6FA8FF), .7, .7, 'Market & competitors'),
  };
  static AgentStyle of(String? template) => map[template] ?? map['ceo']!;
}
