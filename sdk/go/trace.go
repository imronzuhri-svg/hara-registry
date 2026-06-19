package hararegistry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ----------------------------------------------------------------------------
// Trace API schema types (all amounts in litres; all timestamps ISO-8601 UTC).
// Numeric on-chain values are returned as JSON strings by the indexer.
// ----------------------------------------------------------------------------

// BatchSummary describes one ERC-1155 batch.
type BatchSummary struct {
	BatchID        string `json:"batch_id"`
	InitialLiters  string `json:"initial_liters"`
	FirstOwner     string `json:"first_owner"`
	CurrentHolder  string `json:"current_holder"`
	HopCount       string `json:"hop_count"`
	RSPOHash       string `json:"rspo_hash"`
	PlantationID   string `json:"plantation_id"`
	ProductionDate string `json:"production_date"`
	MintedAt       string `json:"minted_at"`
	LastHopAt      string `json:"last_hop_at"`
}

// Hop is a single custody transfer.
type Hop struct {
	BatchID      string `json:"batch_id"`
	Liters       string `json:"liters"`
	FromAddr     string `json:"from_addr"`
	ToAddr       string `json:"to_addr"`
	OperatorAddr string `json:"operator_addr"`
	TxHash       string `json:"tx_hash"`
	BlockNumber  string `json:"block_number"`
	LogIndex     int    `json:"log_index"`
	OccurredAt   string `json:"occurred_at"`
}

// GraphNode is a node in the custody DAG (Cytoscape/React-Flow ready).
type GraphNode struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	HopIndex        int    `json:"hopIndex"`
	ReceivedLiters  string `json:"receivedLiters"`
	SentLiters      string `json:"sentLiters"`
	CurrentLiters   string `json:"currentLiters"`
	IsFirstOwner    bool   `json:"isFirstOwner"`
	IsCurrentHolder bool   `json:"isCurrentHolder"`
	IsPassThrough   bool   `json:"isPassThrough"`
}

// GraphEdge is a transfer edge in the custody DAG.
type GraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	Label        string `json:"label"`
	Liters       string `json:"liters"`
	TxCount      int    `json:"txCount"`
	FirstAt      string `json:"firstAt"`
	LastAt       string `json:"lastAt"`
	SampleTxHash string `json:"sampleTxHash"`
}

// Graph is the response of GetGraph.
type Graph struct {
	Batch      BatchSummary `json:"batch"`
	Nodes      []GraphNode  `json:"nodes"`
	Edges      []GraphEdge  `json:"edges"`
	Aggregated bool         `json:"aggregated"`
}

// HolderBatchesResp is the response of HolderBatches.
type HolderBatchesResp struct {
	Address string   `json:"address"`
	Batches []string `json:"batches"`
}

// batchesResp / hopsResp are list-wrapper envelopes returned by the API.
type batchesResp struct {
	Items []BatchSummary `json:"items"`
}
type hopsResp struct {
	Hops []Hop `json:"hops"`
}

// TraceClient calls the traceability REST API (HTTP Basic auth).
type TraceClient struct {
	baseURL string
	user    string
	pass    string
	http    *http.Client
}

// TraceOption configures a TraceClient.
type TraceOption func(*TraceClient)

// WithBasicAuth sets HTTP Basic credentials for the trace API.
func WithBasicAuth(user, pass string) TraceOption {
	return func(t *TraceClient) {
		t.user = user
		t.pass = pass
	}
}

// WithHTTPClient overrides the default http.Client.
func WithHTTPClient(c *http.Client) TraceOption {
	return func(t *TraceClient) { t.http = c }
}

// WithBaseURL overrides the trace API base URL (e.g. a WG-mesh internal host).
func WithBaseURL(u string) TraceOption {
	return func(t *TraceClient) { t.baseURL = strings.TrimRight(u, "/") }
}

// NewTraceClient builds a TraceClient against the public trace API. Supply
// WithBasicAuth — the endpoint requires HTTP Basic auth.
func NewTraceClient(opts ...TraceOption) *TraceClient {
	t := &TraceClient{
		baseURL: EndpointTrace,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
	for _, o := range opts {
		o(t)
	}
	t.baseURL = strings.TrimRight(t.baseURL, "/")
	return t
}

// get issues a GET to path (which must start with "/") and decodes JSON into out.
func (t *TraceClient) get(ctx context.Context, path string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.baseURL+path, nil)
	if err != nil {
		return err
	}
	if t.user != "" || t.pass != "" {
		req.SetBasicAuth(t.user, t.pass)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("trace GET %s: %w", path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return fmt.Errorf("trace read %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("trace GET %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("trace decode %s: %w", path, err)
	}
	return nil
}

// ListBatches returns batch summaries ordered by minted_at desc.
func (t *TraceClient) ListBatches(ctx context.Context, limit, offset int) ([]BatchSummary, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))
	var r batchesResp
	if err := t.get(ctx, "/v1/batches?"+q.Encode(), &r); err != nil {
		return nil, err
	}
	return r.Items, nil
}

// GetBatch returns a single batch summary (404 => error "batch not found").
func (t *TraceClient) GetBatch(ctx context.Context, batchID string) (*BatchSummary, error) {
	var b BatchSummary
	if err := t.get(ctx, "/v1/batches/"+url.PathEscape(batchID), &b); err != nil {
		return nil, err
	}
	return &b, nil
}

// GetHops returns the custody hops for a batch in custody order.
func (t *TraceClient) GetHops(ctx context.Context, batchID string) ([]Hop, error) {
	var r hopsResp
	if err := t.get(ctx, "/v1/batches/"+url.PathEscape(batchID)+"/hops", &r); err != nil {
		return nil, err
	}
	return r.Hops, nil
}

// GetGraph returns the custody DAG. aggregate=true collapses parallel A->B
// transfers into one weighted edge.
func (t *TraceClient) GetGraph(ctx context.Context, batchID string, aggregate bool) (*Graph, error) {
	q := url.Values{}
	q.Set("aggregate", strconv.FormatBool(aggregate))
	var g Graph
	if err := t.get(ctx, "/v1/batches/"+url.PathEscape(batchID)+"/graph?"+q.Encode(), &g); err != nil {
		return nil, err
	}
	return &g, nil
}

// HolderBatches returns the batch ids a holder address currently holds. The
// holder lookup is case-sensitive; pass the checksummed address.
func (t *TraceClient) HolderBatches(ctx context.Context, address string) (*HolderBatchesResp, error) {
	var r HolderBatchesResp
	if err := t.get(ctx, "/v1/holders/"+url.PathEscape(address)+"/batches", &r); err != nil {
		return nil, err
	}
	return &r, nil
}
