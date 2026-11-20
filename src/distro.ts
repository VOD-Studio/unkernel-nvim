// SPDX-License-Identifier: MIT

export const DISTROS = {
  debian: {
    label: "Debian",
    diskName: "unkernel-nvim-debian",
    image: "/debian.erofs",
    template: "/nvim-data-debian.kwsparse.gz",
  },
  alpine: {
    label: "Alpine",
    diskName: "unkernel-nvim",
    image: "/alpine.erofs",
    template: "/nvim-data.kwsparse.gz",
  },
} as const;

export type Distro = keyof typeof DISTROS;
export const DEFAULT_DISTRO: Distro = "debian";

export function isDistro(value: string | null): value is Distro {
  return value === "debian" || value === "alpine";
}
