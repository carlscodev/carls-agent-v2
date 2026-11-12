/**
 * Semantic colour tokens, ported from opencode's theme so the CLI shares one
 * visual language instead of scattering `pc.cyan` calls.
 *
 * Every value is an RGB triple. `paint` degrades at render time: truecolor when
 * the terminal advertises it, the nearest xterm-256 index otherwise, and plain
 * text when colour is disabled. That ordering matters because a hardcoded 24-bit
 * sequence on an 8-bit terminal renders as garbage, while a 256-colour index on
 * a 24-bit terminal merely looks slightly off.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const hex = (value: string): Rgb => ({
  r: Number.parseInt(value.slice(1, 3), 16),
  g: Number.parseInt(value.slice(3, 5), 16),
  b: Number.parseInt(value.slice(5, 7), 16),
});

/** Greyscale ramp, lightest (100) to darkest (900). */
const gray = {
  100: hex("#ffffff"),
  200: hex("#eeeeee"),
  300: hex("#b5b5b5"),
  400: hex("#808080"),
  500: hex("#4c4c4c"),
  600: hex("#1e1e1e"),
  700: hex("#141414"),
  800: hex("#0a0a0a"),
  900: hex("#030303"),
} as const;

const purple = {
  100: hex("#b38ff4"),
  200: hex("#9d7cd8"),
  300: hex("#8869bd"),
} as const;

const orange = {
  100: hex("#fddac5"),
  200: hex("#fab283"),
  300: hex("#d8976c"),
} as const;

const red = {
  100: hex("#fd7e87"),
  200: hex("#e06c75"),
  300: hex("#c35a63"),
} as const;

const green = {
  100: hex("#96f7a7"),
  200: hex("#7fd88f"),
  300: hex("#68b977"),
} as const;

const cyan = {
  100: hex("#68d0dd"),
  200: hex("#56b6c2"),
  300: hex("#449da7"),
} as const;

const blue = {
  100: hex("#82b4fb"),
  200: hex("#5c9cf5"),
  300: hex("#4c86d6"),
} as const;

/** Neutral accents reused across feedback and chrome. */
const amber = hex("#f5a742");
const sand = hex("#e5c07b");

export interface ThemeTokens {
  readonly text: {
    readonly base: Rgb;
    readonly muted: Rgb;
    readonly faint: Rgb;
  };
  readonly border: Rgb;
  readonly feedback: {
    readonly error: Rgb;
    readonly warning: Rgb;
    readonly success: Rgb;
    readonly info: Rgb;
  };
  readonly diff: {
    readonly added: Rgb;
    readonly removed: Rgb;
    readonly context: Rgb;
    readonly hunkHeader: Rgb;
  };
  readonly syntax: {
    readonly comment: Rgb;
    readonly keyword: Rgb;
    readonly func: Rgb;
    readonly variable: Rgb;
    readonly string: Rgb;
    readonly number: Rgb;
    readonly type: Rgb;
    readonly operator: Rgb;
  };
  readonly markdown: {
    readonly heading: Rgb;
    readonly link: Rgb;
    readonly linkText: Rgb;
    readonly code: Rgb;
    readonly quote: Rgb;
    readonly emphasis: Rgb;
    readonly strong: Rgb;
    readonly bullet: Rgb;
    readonly enumeration: Rgb;
  };
  /** Ordered accent colours for tool glyphs, so related tools read alike. */
  readonly categorical: readonly [Rgb, Rgb, Rgb, Rgb, Rgb];
  readonly accent: Rgb;
  readonly interactive: Rgb;
}

const dark: ThemeTokens = {
  text: { base: gray[200], muted: gray[400], faint: gray[500] },
  border: hex("#484848"),
  feedback: { error: red[200], warning: amber, success: green[200], info: cyan[200] },
  diff: {
    added: hex("#4fd6be"),
    removed: hex("#c53b53"),
    context: hex("#828bb8"),
    hunkHeader: hex("#828bb8"),
  },
  syntax: {
    comment: gray[400],
    keyword: purple[200],
    func: orange[200],
    variable: red[200],
    string: green[200],
    number: amber,
    type: sand,
    operator: cyan[200],
  },
  markdown: {
    heading: purple[200],
    link: orange[200],
    linkText: cyan[200],
    code: green[200],
    quote: sand,
    emphasis: sand,
    strong: amber,
    bullet: orange[200],
    enumeration: cyan[200],
  },
  categorical: [blue[200], purple[200], green[200], orange[200], red[200]],
  accent: purple[200],
  interactive: orange[200],
};

/**
 * Light palette. opencode inverts the ramp so index 200 becomes a dark ink on a
 * light background; keeping the same indices means call sites never branch.
 */
const light: ThemeTokens = {
  text: { base: hex("#1a1a1a"), muted: hex("#4e4e4e"), faint: hex("#8a8a8a") },
  border: hex("#bebebe"),
  feedback: { error: hex("#d1383d"), warning: hex("#c7811e"), success: hex("#3d7f4b"), info: hex("#226c75") },
  diff: {
    added: hex("#2f8f7a"),
    removed: hex("#c20f26"),
    context: hex("#5a6285"),
    hunkHeader: hex("#5a6285"),
  },
  syntax: {
    comment: hex("#8a8a8a"),
    keyword: hex("#7a4fd0"),
    func: hex("#c7811e"),
    variable: hex("#c20f26"),
    string: hex("#2f8f4b"),
    number: hex("#c7811e"),
    type: hex("#8a6d1f"),
    operator: hex("#226c75"),
  },
  markdown: {
    heading: hex("#7a4fd0"),
    link: hex("#c7811e"),
    linkText: hex("#226c75"),
    code: hex("#2f8f4b"),
    quote: hex("#8a6d1f"),
    emphasis: hex("#8a6d1f"),
    strong: hex("#c7811e"),
    bullet: hex("#c7811e"),
    enumeration: hex("#226c75"),
  },
  categorical: [blue[300], purple[300], green[300], orange[300], red[300]],
  accent: purple[300],
  interactive: orange[300],
};

export type ThemeName = "dark" | "light";

/**
 * Resolves the active palette. `CARLS_THEME` wins, then a light terminal is
 * detected from `COLORFGBG` (the only hint a terminal reliably provides), and
 * dark is the default because most terminals are.
 */
export function resolveThemeName(explicit?: string): ThemeName {
  const requested = explicit ?? process.env.CARLS_THEME;
  if (requested === "light" || requested === "dark") return requested;
  const background = process.env.COLORFGBG?.split(";").pop();
  if (background !== undefined && Number(background) >= 9) return "light";
  return "dark";
}

/**
 * Paints text with a semantic colour.
 *
 * Colour is disabled when `NO_COLOR` is set (the de-facto standard), when
 * `FORCE_COLOR` is 0, or when the stream is not a TTY. `force` lets a caller
 * emit colour into a captured buffer regardless of the stream.
 */
export class Theme {
  private readonly tokens: ThemeTokens;
  private readonly depth: 0 | 8 | 24;
  readonly name: ThemeName;

  constructor(name: ThemeName, depth: 0 | 8 | 24) {
    this.name = name;
    this.tokens = name === "light" ? light : dark;
    this.depth = depth;
  }

  /** Chooses a palette and colour depth from the environment. */
  static detect(options: { name?: string; stream?: NodeJS.WriteStream } = {}): Theme {
    const stream = options.stream ?? process.stderr;
    const name = resolveThemeName(options.name);
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return new Theme(name, 0);
    if (process.env.FORCE_COLOR === "0") return new Theme(name, 0);
    const forced = process.env.FORCE_COLOR;
    if (forced !== undefined && forced !== "0") {
      const level = Number(forced);
      return new Theme(name, Number.isFinite(level) && level <= 1 ? 8 : 24);
    }
    if (stream.isTTY !== true) return new Theme(name, 0);
    if ((process.env.COLORTERM ?? "").toLowerCase().includes("truecolor")) return new Theme(name, 24);
    const term = process.env.TERM ?? "";
    if (/256color|truecolor|24bit/i.test(term)) return new Theme(name, 24);
    return new Theme(name, 8);
  }

  get colors(): ThemeTokens {
    return this.tokens;
  }

  /** Wraps `text` in a foreground colour, or returns it untouched when disabled. */
  paint(color: Rgb, text: string): string {
    if (this.depth === 0 || text.length === 0) return text;
    return `\u001b[${this.depth === 24 ? `38;2;${color.r};${color.g};${color.b}` : `38;5;${nearest256(color)}`}m${text}\u001b[39m`;
  }

  bold(text: string): string {
    return this.depth === 0 ? text : `\u001b[1m${text}\u001b[22m`;
  }

  dim(text: string): string {
    return this.depth === 0 ? text : `\u001b[2m${text}\u001b[22m`;
  }

  italic(text: string): string {
    return this.depth === 0 ? text : `\u001b[3m${text}\u001b[23m`;
  }

  underline(text: string): string {
    return this.depth === 0 ? text : `\u001b[4m${text}\u001b[24m`;
  }

  strike(text: string): string {
    return this.depth === 0 ? text : `\u001b[9m${text}\u001b[29m`;
  }

  /** Inverse video, used for the selected row in a list. */
  reverse(text: string): string {
    return this.depth === 0 ? text : `\u001b[7m${text}\u001b[27m`;
  }

  /** Colours from the categorical ramp, cycling for indices past the end. */
  categorical(index: number): Rgb {
    const ramp = this.tokens.categorical;
    return ramp[((index % ramp.length) + ramp.length) % ramp.length] ?? ramp[0];
  }
}

/**
 * Maps a 24-bit colour to the closest xterm-256 index using the 6x6x6 cube plus
 * the 24-step grey ramp. The cube levels are 0,95,135,175,215,255, so a naive
 * `value/51` is wrong at the top end; matching against the real levels keeps
 * dark greys from collapsing into pure black.
 */
export function nearest256(color: Rgb): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const nearestLevel = (value: number): number => {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < levels.length; index++) {
      const distance = Math.abs((levels[index] ?? 0) - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  };
  const cube = 16 + 36 * nearestLevel(color.r) + 6 * nearestLevel(color.g) + nearestLevel(color.b);
  const average = (color.r + color.g + color.b) / 3;
  // The grey ramp is 232..255 with values 8, 18, ... 238: a step of 10, not
  // (255-8)/23, which would bias every mid-grey towards the colour cube.
  const clamped = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const greyValue = 8 + clamped * 10;
  const grey = 232 + clamped;
  const greyDistance =
    (greyValue - color.r) ** 2 + (greyValue - color.g) ** 2 + (greyValue - color.b) ** 2;
  const cubeLevel = (index: number): number => levels[index] ?? 0;
  const cubeDistance =
    (cubeLevel(nearestLevel(color.r)) - color.r) ** 2 +
    (cubeLevel(nearestLevel(color.g)) - color.g) ** 2 +
    (cubeLevel(nearestLevel(color.b)) - color.b) ** 2;
  return greyDistance < cubeDistance ? grey : cube;
}

/** Process-wide theme, so view modules do not thread it through every call. */
let active = Theme.detect();

export function theme(): Theme {
  return active;
}

export function setTheme(next: Theme): void {
  active = next;
}

/** Re-detects after `/theme`, so a switch takes effect immediately. */
export function refreshTheme(explicit?: string): Theme {
  active = Theme.detect(explicit !== undefined ? { name: explicit } : {});
  return active;
}
