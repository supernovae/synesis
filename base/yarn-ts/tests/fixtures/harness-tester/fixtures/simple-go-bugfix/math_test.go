package simplegobugfix

import "testing"

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("Add should add numbers")
	}
}
