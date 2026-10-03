## Summary

<!-- What does this change do and why? -->

## Security impact

Every pull request must complete this section. If a box is checked, explain the mitigation in detail below.

- [ ] Does this add a new inbound event type?
- [ ] Does this add or widen an authorization path?
- [ ] Does this introduce a new CLI/tool/file/network capability?
- [ ] Does it persist or transmit sensitive data?
- [ ] Does it change default-deny behavior?

### If any box is checked, explain here:

<!-- What is the mitigation? What is the default-deny behavior when validation fails? -->

## Changes

- 

## Testing

<!-- How did you verify this works? What tests were added or updated? -->

## Checklist

- [ ] I have read [SECURITY.md](../SECURITY.md) and my change does not violate the security model
- [ ] I have added or updated tests for authorization, routing, or run-state logic
- [ ] I have not introduced permission-bypass defaults (`--dangerously-skip-permissions`, `--yolo`, etc.)
- [ ] I have not added arbitrary shell command execution from Slack
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/)
