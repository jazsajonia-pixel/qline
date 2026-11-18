/// Build-time configuration. Override with --dart-define=QLINE_API=https://...
class AppConfig {
  static const apiBase = String.fromEnvironment(
    'QLINE_API',
    defaultValue: 'https://br-muddy-rain-a1uaplxr-api.compute.c-1.ap-southeast-1.aws.neon.tech',
  );
  static const version = String.fromEnvironment('QLINE_VERSION', defaultValue: '1.7.0');
  static const build = int.fromEnvironment('QLINE_BUILD', defaultValue: 7);
}
