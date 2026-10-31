package dfsm

type RetryPolicy struct {
	MaxAttempts   int
	BackoffMs     int
	BackoffFactor float64
	MaxBackoffMs  int
	Backoff       string
	Jitter        bool
}

type CircuitBreakerPolicy struct {
	Enabled                  bool
	FailureThreshold         int
	RecoveryTimeoutMs        int
	HalfOpenSuccessThreshold int
}

type OnFailPolicy struct {
	Target     string
	Compensate bool
}

type BenchmarkPolicy struct {
	Enabled         bool
	WarnThresholdMs int
}

type TransitionPolicy struct {
	Retry          RetryPolicy
	CircuitBreaker *CircuitBreakerPolicy
	OnFail         *OnFailPolicy
	CompensateWith string
	Benchmark      BenchmarkPolicy
}

func DefaultTransitionPolicy() TransitionPolicy {
	return TransitionPolicy{
		Retry: RetryPolicy{
			MaxAttempts:   1,
			BackoffMs:     100,
			BackoffFactor: 2.0,
			MaxBackoffMs:  10000,
			Backoff:       "EXPONENTIAL",
			Jitter:        false,
		},
		CircuitBreaker: nil,
		OnFail:         nil,
		CompensateWith: "",
		Benchmark: BenchmarkPolicy{
			Enabled:         true,
			WarnThresholdMs: 1000,
		},
	}
}

type PartialTransitionPolicy struct {
	RetryMaxAttempts   *int
	RetryBackoffMs     *int
	RetryBackoffFactor *float64
	RetryMaxBackoffMs  *int
	RetryBackoff       *string
	RetryJitter        *bool
	RetryDefined       bool

	CbEnabled            *bool
	CbFailureThreshold   *int
	CbRecoveryTimeoutMs  *int
	CbHalfOpenSuccess    *int
	CbDefined            bool

	OnFailTarget     *string
	OnFailCompensate *bool
	OnFailDefined    bool

	CompensateWith *string

	BenchmarkEnabled *bool
	BenchmarkWarnMs  *int
}

func MergePolicies(layers ...*PartialTransitionPolicy) TransitionPolicy {
	def := DefaultTransitionPolicy()

	maxAttempts := def.Retry.MaxAttempts
	backoffMs := def.Retry.BackoffMs
	backoffFactor := def.Retry.BackoffFactor
	maxBackoffMs := def.Retry.MaxBackoffMs
	backoff := def.Retry.Backoff
	jitter := def.Retry.Jitter

	for _, l := range layers {
		if l == nil {
			continue
		}
		if l.RetryDefined || l.RetryMaxAttempts != nil {
			if l.RetryMaxAttempts != nil {
				maxAttempts = *l.RetryMaxAttempts
			}
			if l.RetryBackoffMs != nil {
				backoffMs = *l.RetryBackoffMs
			}
			if l.RetryBackoffFactor != nil {
				backoffFactor = *l.RetryBackoffFactor
			}
			if l.RetryMaxBackoffMs != nil {
				maxBackoffMs = *l.RetryMaxBackoffMs
			}
			if l.RetryBackoff != nil {
				backoff = *l.RetryBackoff
			}
			if l.RetryJitter != nil {
				jitter = *l.RetryJitter
			}
			break // Non-multiplying retries!
		}
	}

	var cbPolicy *CircuitBreakerPolicy
	for _, l := range layers {
		if l == nil {
			continue
		}
		if l.CbDefined || l.CbFailureThreshold != nil {
			ft := 5
			if l.CbFailureThreshold != nil {
				ft = *l.CbFailureThreshold
			}
			rt := 30000
			if l.CbRecoveryTimeoutMs != nil {
				rt = *l.CbRecoveryTimeoutMs
			}
			st := 2
			if l.CbHalfOpenSuccess != nil {
				st = *l.CbHalfOpenSuccess
			}
			en := true
			if l.CbEnabled != nil {
				en = *l.CbEnabled
			}
			cbPolicy = &CircuitBreakerPolicy{
				Enabled:                  en,
				FailureThreshold:         ft,
				RecoveryTimeoutMs:        rt,
				HalfOpenSuccessThreshold: st,
			}
			break
		}
	}

	var onFailPolicy *OnFailPolicy
	for _, l := range layers {
		if l == nil {
			continue
		}
		if l.OnFailDefined || l.OnFailTarget != nil || l.OnFailCompensate != nil {
			tgt := "error"
			if l.OnFailTarget != nil {
				tgt = *l.OnFailTarget
			}
			comp := false
			if l.OnFailCompensate != nil {
				comp = *l.OnFailCompensate
			}
			onFailPolicy = &OnFailPolicy{
				Target:     tgt,
				Compensate: comp,
			}
			break
		}
	}

	var compWith string
	for _, l := range layers {
		if l != nil && l.CompensateWith != nil {
			compWith = *l.CompensateWith
			break
		}
	}

	benchEnabled := true
	benchWarn := 1000
	for _, l := range layers {
		if l == nil {
			continue
		}
		if l.BenchmarkEnabled != nil {
			benchEnabled = *l.BenchmarkEnabled
			if l.BenchmarkWarnMs != nil {
				benchWarn = *l.BenchmarkWarnMs
			}
			break
		}
	}

	return TransitionPolicy{
		Retry: RetryPolicy{
			MaxAttempts:   maxAttempts,
			BackoffMs:     backoffMs,
			BackoffFactor: backoffFactor,
			MaxBackoffMs:  maxBackoffMs,
			Backoff:       backoff,
			Jitter:        jitter,
		},
		CircuitBreaker: cbPolicy,
		OnFail:         onFailPolicy,
		CompensateWith: compWith,
		Benchmark: BenchmarkPolicy{
			Enabled:         benchEnabled,
			WarnThresholdMs: benchWarn,
		},
	}
}

