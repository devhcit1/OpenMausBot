import { describe, expect, it } from "vitest";

import { userSessionEnv } from "./user-session-env.ts";

const owners = (files: Record<string, number>) => (path: string) => {
  if (!(path in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return { uid: files[path]! };
};

describe("the user session rootless Podman needs", () => {
  it("names the user's own runtime folder and bus when the service started without them", () => {
    expect(userSessionEnv({}, 994, owners({ "/run/user/994": 994, "/run/user/994/bus": 994 }))).toEqual({
      XDG_RUNTIME_DIR: "/run/user/994", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/994/bus",
    });
    expect(userSessionEnv({}, 994, owners({ "/run/user/994": 994 }))).toEqual({ XDG_RUNTIME_DIR: "/run/user/994" });
  });

  it("keeps what is set, and never adopts a folder or bus someone else owns, or any for root", () => {
    expect(userSessionEnv({ XDG_RUNTIME_DIR: "/x", DBUS_SESSION_BUS_ADDRESS: "unix:path=/y" }, 994, owners({ "/run/user/994": 994, "/run/user/994/bus": 994 }))).toEqual({});
    expect(userSessionEnv({}, 994, owners({ "/run/user/994": 0, "/run/user/994/bus": 994 }))).toEqual({});
    expect(userSessionEnv({}, 994, owners({ "/run/user/994": 994, "/run/user/994/bus": 1001 }))).toEqual({ XDG_RUNTIME_DIR: "/run/user/994" });
    expect(userSessionEnv({}, 994, owners({}))).toEqual({});
    expect(userSessionEnv({}, 0, owners({ "/run/user/0": 0, "/run/user/0/bus": 0 }))).toEqual({});
  });
});
