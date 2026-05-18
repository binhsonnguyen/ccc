package claudefs

import "testing"

func TestEncodeCWD(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/Users/_/Chats/fct-summer-camp", "-Users---Chats-fct-summer-camp"},
		// Space → '-'. Pre-fix this returned "-Users---Documents-Chats-Diablo 2-…"
		// which didn't match Claude's real dir and stalled discovery for any
		// cwd containing a space.
		{"/Users/_/Documents/Chats/Diablo 2/Tools/d2-maxroll-engine",
			"-Users---Documents-Chats-Diablo-2-Tools-d2-maxroll-engine"},
		// Dot in name (filename-style) → '-'.
		{"/home/u/proj.test", "-home-u-proj-test"},
		// Hyphen preserved; consecutive non-alnum runs map 1:1.
		{"a/b-c", "a-b-c"},
		// Empty stays empty.
		{"", ""},
	}
	for _, c := range cases {
		got := encodeCWD(c.in)
		if got != c.want {
			t.Errorf("encodeCWD(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
