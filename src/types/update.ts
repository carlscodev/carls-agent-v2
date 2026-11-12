/**
 * How a detected release is handled at startup.
 *
 * Lives here rather than in the config layer so the updater and the config
 * loader can both depend on the contract without depending on each other.
 */
export type AutoUpdateMode = "auto" | "notify" | "off";

export const AUTO_UPDATE_MODES: AutoUpdateMode[] = ["auto", "notify", "off"];
