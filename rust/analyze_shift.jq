# Independent validation and aggregation of every recorded evaluation row.
. as $report |
def invalid:
  (.groups | length) != 4 or
  .heldout_fpr != (.benign_false_positives / .benign_total) or
  .empirical_fpr_exceeds_budget != (.heldout_fpr > .target_fpr) or
  .calibration_false_positives > (.benign_total * .target_fpr | floor) or
  (.groups | any(.total <= 0 or .detected < 0 or .detected > .total or .tpr != (.detected / .total))) or
  (.worst_group_tpr != ([.groups[].tpr] | min)) or
  ((.macro_tpr - ([.groups[].tpr] | add / length)) | fabs) > 1e-12 or
  .fpr_wilson95[0] > .heldout_fpr or .fpr_wilson95[1] < .heldout_fpr;
{
  rows: (.rows | length),
  unique_row_keys: ([.rows[] | [.seed,.domain,.severity,.protocol,.target_fpr]] | unique | length),
  invalid_rows: [.rows[] | select(invalid)],
  summary_count_matches: (.fpr_violation_count == ([.rows[] | select(.empirical_fpr_exceeds_budget)] | length)),
  by_domain_budget: (.rows | group_by([.domain,.target_fpr]) | map({
    domain:.[0].domain, target_fpr:.[0].target_fpr, rows:length,
    violations:([.[] | select(.empirical_fpr_exceeds_budget)]|length),
    mean_fpr:(map(.heldout_fpr)|add/length), max_fpr:(map(.heldout_fpr)|max),
    mean_worst_tpr:(map(.worst_group_tpr)|add/length)
  })),
  by_protocol_domain_budget: (.rows | group_by([.protocol,.domain,.target_fpr]) | map({
    protocol:.[0].protocol, domain:.[0].domain, target_fpr:.[0].target_fpr, rows:length,
    mean_fpr:(map(.heldout_fpr)|add/length), mean_worst_tpr:(map(.worst_group_tpr)|add/length)
  })),
  note:"Row aggregates are descriptive. Shared samples and thresholds mean rows are not independent trials. Empirical excess alone is not a statistical significance test."
}
