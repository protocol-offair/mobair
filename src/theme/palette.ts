import { Appearance, Platform, type TextStyle, type ViewStyle } from "react-native";

export interface AppThemeTokens {
  background: string;
  backgroundElevated: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  overlay: string;
  line: string;
  lineStrong: string;
  ink: string;
  muted: string;
  mutedStrong: string;
  sky: string;
  skySoft: string;
  cyan: string;
  amber: string;
  amberSoft: string;
  mint: string;
  coral: string;
  dangerSurface: string;
}

export type AppThemeMode = "light" | "dark";

type AppThemePalette = AppThemeTokens & Record<"success" | "warning" | "danger", string>;

export const lightPalette: AppThemePalette = {
  background: "#F8FAF5",
  backgroundElevated: "#EEF5EC",
  surface: "#FFFFFF",
  surfaceAlt: "#F8FAF5",
  surfaceRaised: "#FFFFFF",
  overlay: "rgba(247,250,244,0.94)",
  line: "rgba(17,26,20,0.08)",
  lineStrong: "rgba(17,26,20,0.14)",
  ink: "#111A14",
  muted: "#536056",
  mutedStrong: "#7B867E",
  sky: "#0E6F3B",
  skySoft: "#DFF7E8",
  cyan: "#0E9FA5",
  amber: "#B77905",
  amberSoft: "#F2B84B",
  mint: "#16A35C",
  coral: "#D94A3A",
  dangerSurface: "rgba(217,74,58,0.08)",
  success: "#16A35C",
  warning: "#B77905",
  danger: "#D94A3A",
};

export const darkPalette: AppThemePalette = {
  background: "#060806",
  backgroundElevated: "#0A100C",
  surface: "#10160F",
  surfaceAlt: "#0C120D",
  surfaceRaised: "#141B12",
  overlay: "rgba(8,12,8,0.94)",
  line: "rgba(232,246,224,0.12)",
  lineStrong: "rgba(232,246,224,0.2)",
  ink: "#F4F7EE",
  muted: "#AEB8A8",
  mutedStrong: "#7E8A7B",
  sky: "#B8F35A",
  skySoft: "rgba(184,243,90,0.14)",
  cyan: "#37D6CA",
  amber: "#F6B84A",
  amberSoft: "#FFD37A",
  mint: "#7CF39B",
  coral: "#FF7D67",
  dangerSurface: "rgba(255,125,103,0.12)",
  success: "#7CF39B",
  warning: "#F6B84A",
  danger: "#FF7D67",
};

function configuredThemeMode(): AppThemeMode {
  const configured = process.env.EXPO_PUBLIC_AIRPAY_THEME?.trim().toLowerCase();
  if (configured === "light" || configured === "dark") {
    return configured;
  }
  return Appearance.getColorScheme() === "dark" ? "dark" : "light";
}

export const themeMode: AppThemeMode = configuredThemeMode();
export const isDarkTheme = themeMode === "dark";
export const palette: AppThemePalette = isDarkTheme ? darkPalette : lightPalette;

export const gradients = isDarkTheme
  ? {
      appBackground: ["#060806", "#0A100C"] as const,
      glowLeft: "rgba(184,243,90,0.08)",
      glowRight: "rgba(55,214,202,0.07)",
      hero: ["#0E6F3B", "#101A10"] as const,
      heroDark: ["#0B130E", "#111A12"] as const,
      accent: ["#B8F35A", "#37D6CA"] as const,
      receive: ["#101A10", "#0D5654"] as const,
    }
  : {
      appBackground: ["#F8FAF5", "#ECF2E8"] as const,
      glowLeft: "rgba(22,163,92,0.06)",
      glowRight: "rgba(14,159,165,0.05)",
      hero: ["#0E6F3B", "#0E6F3B"] as const,
      heroDark: ["#0B130E", "#0B130E"] as const,
      accent: ["#B8F35A", "#0E9FA5"] as const,
      receive: ["#0E6F3B", "#0E9FA5"] as const,
};

export const spacing = {
  screenPadding: 18,
  sectionGap: 20,
  cardPadding: 18,
  compactCardPadding: 18,
  rowGap: 12,
  buttonHeight: 52,
  tabBarInset: 20,
};

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  hero: 8,
  pill: 999,
};

export const iconSizes = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
};

export const fontFamilies = {
  regular: "Manrope_400Regular",
  medium: "Manrope_400Regular",
  semibold: "Manrope_700Bold",
  bold: "Manrope_700Bold",
  extrabold: "Manrope_700Bold",
  mono: Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "monospace",
  }) as string,
};

export const typeRamp = {
  display: {
    fontFamily: fontFamilies.extrabold,
    fontSize: 34,
    lineHeight: 39,
    letterSpacing: 0,
    color: palette.ink,
  } as TextStyle,
  headline: {
    fontFamily: fontFamilies.bold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: 0,
    color: palette.ink,
  } as TextStyle,
  title: {
    fontFamily: fontFamilies.bold,
    fontSize: 18,
    lineHeight: 28,
    letterSpacing: 0,
    color: palette.ink,
  } as TextStyle,
  titleCompact: {
    fontFamily: fontFamilies.bold,
    fontSize: 16,
    lineHeight: 24,
    color: palette.ink,
  } as TextStyle,
  body: {
    fontFamily: fontFamilies.regular,
    fontSize: 14,
    lineHeight: 20,
    color: palette.muted,
  } as TextStyle,
  bodyStrong: {
    fontFamily: fontFamilies.medium,
    fontSize: 14,
    lineHeight: 20,
    color: palette.ink,
  } as TextStyle,
  caption: {
    fontFamily: fontFamilies.regular,
    fontSize: 11,
    lineHeight: 16.5,
    color: palette.muted,
  } as TextStyle,
  label: {
    fontFamily: fontFamilies.semibold,
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0,
    textTransform: "uppercase",
    color: palette.muted,
  } as TextStyle,
  chip: {
    fontFamily: fontFamilies.bold,
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0,
    textTransform: "uppercase",
  } as TextStyle,
  mono: {
    fontFamily: fontFamilies.mono,
    fontSize: 12,
    lineHeight: 16,
    color: palette.muted,
  } as TextStyle,
};

const androidShadowElevation = (elevation: number): ViewStyle =>
  Platform.OS === "android"
    ? {
        elevation,
      }
    : {};

export const shadows = {
  floating: {
    shadowColor: isDarkTheme ? "#000000" : "#0B130E",
    shadowOpacity: isDarkTheme ? 0.28 : 0.06,
    shadowRadius: isDarkTheme ? 18 : 12,
    shadowOffset: { width: 0, height: isDarkTheme ? 10 : 6 },
    ...androidShadowElevation(5),
  } as ViewStyle,
  hero: {
    shadowColor: "#000000",
    shadowOpacity: isDarkTheme ? 0.34 : 0.16,
    shadowRadius: isDarkTheme ? 22 : 16,
    shadowOffset: { width: 0, height: isDarkTheme ? 12 : 8 },
    ...androidShadowElevation(6),
  } as ViewStyle,
  button: {
    shadowColor: isDarkTheme ? "#B8F35A" : "#0E6F3B",
    shadowOpacity: isDarkTheme ? 0.18 : 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    ...androidShadowElevation(4),
  } as ViewStyle,
};

export function statusToneColor(tone: "info" | "success" | "warning" | "danger" | "muted") {
  switch (tone) {
    case "success":
      return palette.mint;
    case "warning":
      return palette.amber;
    case "danger":
      return palette.coral;
    case "muted":
      return palette.mutedStrong;
    case "info":
    default:
      return palette.cyan;
  }
}

export function statusToneBackground(tone: "info" | "success" | "warning" | "danger" | "muted") {
  switch (tone) {
    case "success":
      return "rgba(34,197,94,0.12)";
    case "warning":
      return "rgba(255,179,0,0.12)";
    case "danger":
      return "rgba(255,124,112,0.12)";
    case "muted":
      return "rgba(158,163,174,0.12)";
    case "info":
    default:
      return "rgba(69,216,237,0.12)";
  }
}
