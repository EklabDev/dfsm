package dfsm

import (
	"sync/atomic"
	"time"
)

type Clock interface {
	NowMs() int64
	Sleep(d time.Duration)
}

type RealClock struct{}

func (RealClock) NowMs() int64 {
	return time.Now().UnixMilli()
}

func (RealClock) Sleep(d time.Duration) {
	time.Sleep(d)
}

type VirtualClock struct {
	nowMs atomic.Int64
}

func NewVirtualClock(initialMs int64) *VirtualClock {
	vc := &VirtualClock{}
	vc.nowMs.Store(initialMs)
	return vc
}

func (v *VirtualClock) NowMs() int64 {
	return v.nowMs.Load()
}

func (v *VirtualClock) Advance(deltaMs int64) {
	v.nowMs.Add(deltaMs)
}

func (v *VirtualClock) SetTime(ms int64) {
	v.nowMs.Store(ms)
}

func (v *VirtualClock) Sleep(d time.Duration) {
	v.Advance(d.Milliseconds())
}

