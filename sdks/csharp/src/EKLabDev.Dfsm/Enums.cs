namespace EKLabDev.Dfsm;

public enum TransactionStatus
{
    IDLE,
    IN_FLIGHT,
    COMPENSATING,
    COMPENSATED,
    COMPLETED,
    FAILED
}

public enum ForceCleanUpAction
{
    COMPENSATE,
    MARK_FAIL,
    DELETE,
    CONTINUE
}

public enum HookType
{
    OnStart,
    BeforeTransition,
    AfterTransition,
    OnCompensate,
    OnComplete,
    OnTerminal
}
