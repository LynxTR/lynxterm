import { expect, test } from "vite-plus/test";
import { lineKind } from "../app/composables/loginPrompt";

test("setup waits out login questions, types only at a prompt", () => {
  // Forced password change on a new Hetzner server
  expect(lineKind("Current password: ")).toBe("asking");
  expect(lineKind("New password: ")).toBe("asking");
  expect(lineKind("Retype new password: ")).toBe("asking");
  expect(lineKind("[sudo] password for lynx: ")).toBe("asking");
  expect(lineKind("Enter passphrase for key '/root/.ssh/id_ed25519': ")).toBe("asking");
  expect(lineKind("Are you sure you want to continue connecting (yes/no)? ")).toBe("asking");

  expect(lineKind("root@ubuntu-4gb-hel1-1:~# ")).toBe("prompt");
  expect(lineKind("lynx@box:~/src$ ")).toBe("prompt");
  expect(lineKind("~/src on main ❯ ")).toBe("prompt");

  expect(lineKind("Select a project: 1) web 2) api ")).toBe("unsure");
  expect(lineKind("➜  src git:(main) ✗ ")).toBe("unsure");
});
