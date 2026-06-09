package main

import (
	"os"
	"testing"
)

// The shell-init constants must stay byte-identical to the shipped shell
// files, so brew users (eval "$(c3-bin shell-init …)") and source-install
// users (source shell/c3.sh) get the exact same `c3` function. If you edit
// one, edit the other.
func TestShellInitMatchesShippedFiles(t *testing.T) {
	cases := []struct {
		name string
		path string
		got  string
	}{
		{"c3.sh", "../../shell/c3.sh", c3ShimPOSIX},
		{"c3.fish", "../../shell/c3.fish", c3ShimFish},
	}
	for _, c := range cases {
		want, err := os.ReadFile(c.path)
		if err != nil {
			t.Fatalf("%s: read shipped file: %v", c.name, err)
		}
		if string(want) != c.got {
			t.Errorf("%s drifted from %s — keep the const and the file identical", c.name, c.path)
		}
	}
}

func TestShellInitUnknownShell(t *testing.T) {
	if err := cmdShellInit([]string{"powershell"}); err == nil {
		t.Fatal("want error for unsupported shell, got nil")
	}
	if err := cmdShellInit(nil); err == nil {
		t.Fatal("want error for missing shell arg, got nil")
	}
}
