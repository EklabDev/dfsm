using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Policy;
using EKLabDev.Dfsm.Store;
using EKLabDev.Dfsm.Telemetry;
using EKLabDev.Dfsm.Validation;

namespace EKLabDev.Dfsm.Runtime;

public class FSMRegistry
{
    private readonly ConcurrentDictionary<string, MachineDefinition> _machines = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (Delegate Handler, PartialTransitionPolicy Policy)> _transitions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Delegate> _compensations = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Delegate> _effects = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<HookType, List<Delegate>> _hooks = new();

    public IStateStore Store { get; }
    public IBenchmarkLogEngine BenchmarkEngine { get; }
    public ISystemClock Clock { get; }
    public ISchemaValidator Validator { get; }
    public PartialTransitionPolicy GlobalPolicy { get; }

    public FSMRegistry(
        IStateStore? store = null,
        IBenchmarkLogEngine? benchmarkEngine = null,
        ISystemClock? clock = null,
        ISchemaValidator? validator = null,
        PartialTransitionPolicy? globalPolicy = null)
    {
        Store = store ?? new SqliteStateStore();
        BenchmarkEngine = benchmarkEngine ?? ConsoleBenchmarkLogEngine.Instance;
        Clock = clock ?? RealSystemClock.Instance;
        Validator = validator ?? DataAnnotationsSchemaValidator.Instance;
        GlobalPolicy = globalPolicy ?? PartialTransitionPolicy.Empty;

        foreach (HookType ht in Enum.GetValues<HookType>())
        {
            _hooks[ht] = new List<Delegate>();
        }
    }

    public void RegisterMachine(MachineDefinition machine)
    {
        _machines[machine.Id] = machine;
    }

    public MachineDefinition? GetMachine(string machineId)
    {
        _machines.TryGetValue(machineId, out var machine);
        return machine;
    }

    public void RegisterTransition(string eventName, Delegate handler, PartialTransitionPolicy? policy = null)
    {
        _transitions[eventName] = (handler, policy ?? PartialTransitionPolicy.Empty);
    }

    public (Delegate Handler, PartialTransitionPolicy Policy)? GetTransition(string eventName)
    {
        if (_transitions.TryGetValue(eventName, out var item)) return item;
        int dot = eventName.LastIndexOf('.');
        if (dot >= 0 && _transitions.TryGetValue(eventName.Substring(dot + 1), out var unqualified))
        {
            return unqualified;
        }
        return null;
    }

    public void RegisterCompensate(string name, Delegate handler)
    {
        _compensations[name] = handler;
    }

    public Delegate? GetCompensate(string name)
    {
        if (_compensations.TryGetValue(name, out var d)) return d;
        int dot = name.LastIndexOf('.');
        if (dot >= 0 && _compensations.TryGetValue(name.Substring(dot + 1), out var unqualified))
        {
            return unqualified;
        }
        return null;
    }

    public void RegisterEffect(string name, Delegate handler)
    {
        _effects[name] = handler;
    }

    public Delegate? GetEffect(string name)
    {
        if (_effects.TryGetValue(name, out var d)) return d;
        int dot = name.LastIndexOf('.');
        if (dot >= 0 && _effects.TryGetValue(name.Substring(dot + 1), out var unqualified))
        {
            return unqualified;
        }
        return null;
    }

    public void RegisterHook(HookType hookType, Delegate handler)
    {
        _hooks[hookType].Add(handler);
    }

    public IReadOnlyList<Delegate> GetHooks(HookType hookType)
    {
        return _hooks[hookType];
    }

    public void RegisterAnnotatedHandlers(object target)
    {
        var type = target.GetType();
        var methods = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

        foreach (var m in methods)
        {
            // Transitions
            var transAttrs = m.GetCustomAttributes<DfsmTransitionAttribute>();
            var retryAttr = m.GetCustomAttribute<RetryAttribute>();
            var backoffAttr = m.GetCustomAttribute<BackoffAttribute>();
            var cbAttr = m.GetCustomAttribute<CircuitBreakerAttribute>();
            var onFailAttr = m.GetCustomAttribute<OnFailAttribute>();
            var compWithAttr = m.GetCustomAttribute<CompensateWithAttribute>();
            var benchAttr = m.GetCustomAttribute<BenchmarkAttribute>();

            var policy = PartialTransitionPolicy.FromAttributes(retryAttr, backoffAttr, cbAttr, onFailAttr, compWithAttr, benchAttr);

            foreach (var t in transAttrs)
            {
                var del = CreateDelegate(m, target);
                RegisterTransition(t.EventName, del, policy);
            }

            // Compensations
            var compAttr = m.GetCustomAttribute<DfsmCompensateAttribute>();
            if (compAttr != null)
            {
                RegisterCompensate(compAttr.Name, CreateDelegate(m, target));
            }

            // Effects
            var effAttr = m.GetCustomAttribute<DfsmEffectAttribute>();
            if (effAttr != null)
            {
                RegisterEffect(effAttr.Name, CreateDelegate(m, target));
            }

            // Hooks
            var hookAttrs = m.GetCustomAttributes<DfsmHookAttribute>();
            foreach (var h in hookAttrs)
            {
                RegisterHook(h.HookType, CreateDelegate(m, target));
            }
        }
    }

    private Delegate CreateDelegate(MethodInfo method, object target)
    {
        var paramTypes = new List<Type>();
        foreach (var p in method.GetParameters())
        {
            paramTypes.Add(p.ParameterType);
        }

        if (method.ReturnType == typeof(void))
        {
            var actionType = System.Linq.Expressions.Expression.GetActionType(paramTypes.ToArray());
            return Delegate.CreateDelegate(actionType, target, method);
        }
        else
        {
            paramTypes.Add(method.ReturnType);
            var funcType = System.Linq.Expressions.Expression.GetFuncType(paramTypes.ToArray());
            return Delegate.CreateDelegate(funcType, target, method);
        }
    }

    public DfsmActor<TContext> CreateActor<TContext>(string machineId)
    {
        var machine = GetMachine(machineId)
            ?? throw new InvalidOperationException($"Machine '{machineId}' is not registered.");
        return new DfsmActor<TContext>(machine, this);
    }
}
