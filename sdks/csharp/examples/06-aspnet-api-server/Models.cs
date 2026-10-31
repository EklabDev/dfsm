using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using EKLabDev.Dfsm;

namespace EKLabDev.Dfsm.SampleServer;

public class OrderItem
{
    [Required]
    public string Sku { get; set; } = string.Empty;

    [Range(1, 100)]
    public int Quantity { get; set; }

    [Range(0.01, 100000.0)]
    public decimal UnitPrice { get; set; }
}

public class OrderApiContext
{
    public string OrderId { get; set; } = string.Empty;
    public string CustomerEmail { get; set; } = string.Empty;
    public List<OrderItem> Items { get; set; } = new();
    public bool Priority { get; set; }
    public decimal TotalAmount { get; set; }
    public string? PaymentAuthId { get; set; }
    public string? Carrier { get; set; }
    public string? TrackingNumber { get; set; }
    public decimal? BoxWeightKg { get; set; }
}

public class SubmitOrderInput
{
    public string? OrderId { get; set; }

    [Required]
    [EmailAddress]
    public string CustomerEmail { get; set; } = string.Empty;

    [Required]
    [MinLength(1)]
    public List<OrderItem> Items { get; set; } = new();

    public bool Priority { get; set; }
}

public class AuthorizePaymentInput
{
    [Required]
    public string PaymentAuthId { get; set; } = string.Empty;
}

public class CompletePackingInput
{
    [Range(0.1, 1000.0)]
    public decimal BoxWeightKg { get; set; }
}

public class BookCarrierInput
{
    [Required]
    public string Carrier { get; set; } = string.Empty;

    [Required]
    public string TrackingNumber { get; set; } = string.Empty;

    public bool SimulateFailure { get; set; }
}

public class TransitionRequestDto
{
    [Required]
    public string Event { get; set; } = string.Empty;
    public object? Input { get; set; }
}

public class CleanUpRequestDto
{
    public ForceCleanUpAction Action { get; set; } = ForceCleanUpAction.COMPENSATE;
    public List<string>? TransactionIds { get; set; }
    public bool DryRun { get; set; } = false;
    public int Limit { get; set; } = 100;
}

