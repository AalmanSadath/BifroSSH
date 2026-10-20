/**
 * True when the app is running on Android.
 *
 * From the user agent rather than the `platform` command so it is known on
 * the first render: the controls it hides would otherwise flash up and
 * vanish. Android's WebView always says Android in its user agent.
 */
export const isAndroid = /\bAndroid\b/.test(navigator.userAgent);
