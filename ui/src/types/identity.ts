export type IdentityUser = {
  email?: string;
  token?: { access_token?: string };
};

export type NetlifyIdentity = {
  init: () => void;
  open: (tab?: "login" | "signup") => void;
  close?: () => void;
  currentUser: () => IdentityUser | null;
  on: (event: "init" | "login" | "logout", callback: (user?: IdentityUser) => void) => void;
  logout: () => void;
};

declare global {
  interface Window { netlifyIdentity?: NetlifyIdentity; }
}
