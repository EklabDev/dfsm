package io.github.eklabdev.dfsm.sample.filter;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingRequestWrapper;
import org.springframework.web.util.ContentCachingResponseWrapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestResponseLoggingFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(RequestResponseLoggingFilter.class);
    private final ObjectMapper mapper = new ObjectMapper();

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        long startTime = System.currentTimeMillis();

        ContentCachingRequestWrapper reqWrapper = new ContentCachingRequestWrapper(request);
        ContentCachingResponseWrapper respWrapper = new ContentCachingResponseWrapper(response);

        try {
            filterChain.doFilter(reqWrapper, respWrapper);
        } finally {
            long duration = System.currentTimeMillis() - startTime;
            logRequest(reqWrapper);
            logResponse(reqWrapper, respWrapper, duration);
            respWrapper.copyBodyToResponse();
        }
    }

    private void logRequest(ContentCachingRequestWrapper req) {
        String body = "";
        byte[] buf = req.getContentAsByteArray();
        if (buf.length > 0) {
            body = " | body=" + new String(buf, StandardCharsets.UTF_8).replace("\n", "").replace("\r", "");
        }
        log.info("--> {} {}{}", req.getMethod(), req.getRequestURI(), body);
    }

    private void logResponse(ContentCachingRequestWrapper req, ContentCachingResponseWrapper res, long durationMs) {
        List<String> parts = new ArrayList<>();
        parts.add(String.format("<-- %d %s %s (%dms)", res.getStatus(), req.getMethod(), req.getRequestURI(), durationMs));

        byte[] buf = res.getContentAsByteArray();
        if (buf.length > 0) {
            try {
                JsonNode json = mapper.readTree(buf);
                if (json.isObject()) {
                    if (json.has("transactionId")) {
                        parts.add("txId=" + json.get("transactionId").asText());
                    }
                    if (json.has("currentState")) {
                        parts.add("currentState=" + json.get("currentState").toString());
                    }
                    if (json.has("status")) {
                        parts.add("status=" + json.get("status").asText());
                    }
                    if (json.has("stepResult")) {
                        parts.add("result=" + json.get("stepResult").toString());
                    } else if (json.has("error") || json.has("code")) {
                        parts.add("result=" + json.toString());
                    }
                    if (json.has("availableEvents")) {
                        parts.add("availableEvents=" + json.get("availableEvents").toString());
                    }
                    if (json.has("nonTerminalCount")) {
                        parts.add("nonTerminalCount=" + json.get("nonTerminalCount").asText());
                    }
                }
            } catch (Exception ignored) {}
        }

        log.info(String.join(" | ", parts));
    }
}

