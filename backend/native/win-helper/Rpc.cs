using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace WinHelper;

public sealed class RpcException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// Line-delimited JSON-RPC 2.0 over stdio. stdout is reserved for protocol frames; diagnostics go to
/// stderr as structured JSON lines (consumed by the Electron HelperSupervisor log).
/// </summary>
public static class Rpc
{
    private static readonly object WriteLock = new();
    private static readonly Stream Stdout = Console.OpenStandardOutput();
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static void Send(JsonObject frame)
    {
        var bytes = Encoding.UTF8.GetBytes(frame.ToJsonString() + "\n");
        lock (WriteLock)
        {
            Stdout.Write(bytes);
            Stdout.Flush();
        }
    }

    public static void Notify(string method, object? payload)
    {
        Send(new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["method"] = method,
            ["params"] = payload is null ? null : JsonSerializer.SerializeToNode(payload, Json),
        });
    }

    public static void Log(string level, string operation, object? context = null, Exception? err = null)
    {
        var rec = new JsonObject
        {
            ["timestamp"] = DateTime.UtcNow.ToString("O"),
            ["level"] = level,
            ["operation"] = operation,
            ["module"] = "win-helper",
        };
        if (context is not null) rec["context"] = JsonSerializer.SerializeToNode(context, Json);
        if (err is not null) rec["error"] = new JsonObject { ["type"] = err.GetType().FullName, ["message"] = err.Message, ["stack"] = err.StackTrace };
        lock (WriteLock) Console.Error.WriteLine(rec.ToJsonString());
    }

    public static async Task Serve(Func<string, JsonNode?, Task<object?>> dispatch, CancellationToken ct)
    {
        using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break; // parent closed stdin → shut down
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonNode? req;
            try { req = JsonNode.Parse(line); }
            catch (JsonException) { SendError(null, -32700, "parse error"); continue; }
            var id = req?["id"]?.GetValue<long?>();
            var method = req?["method"]?.GetValue<string>();
            if (method is null) { SendError(id, -32600, "invalid request"); continue; }
            _ = Task.Run(async () =>
            {
                try
                {
                    var result = await dispatch(method, req?["params"]);
                    if (id is not null)
                        Send(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = JsonSerializer.SerializeToNode(result, Json) });
                }
                catch (RpcException ex) { SendError(id, ex.Code, ex.Message); }
                catch (Exception ex)
                {
                    Log("error", $"rpc.{method}", null, ex);
                    SendError(id, -32000, ex.Message);
                }
            }, ct);
        }
    }

    private static void SendError(long? id, int code, string message) =>
        Send(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id ?? 0, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } });
}
