# AWS support request — Function URL invocation and account limits

Not a document about the vault. This is the text to paste into an AWS support case, kept
here so the evidence behind it does not have to be gathered twice.

**How to file.** The AWS Support **API** requires a Business or Enterprise plan, so this
cannot be submitted from the CLI — `aws support describe-severity-levels` returns
`SubscriptionRequiredException`. Account and billing cases are free from the console:
Support Center → Create case → **Account and billing** → Service: *Account* → Category:
*Other Account Issues*.

---

## Subject

Lambda Function URL rejects CloudFront OAC and public invocation; account concurrency limit is 10

## Body

Account: 505521407909
Region: ap-south-1

I am unable to invoke a Lambda Function URL from CloudFront using an Origin Access
Control, and I believe my account is under new-account restrictions rather than
misconfigured. I would like the restrictions reviewed and lifted.

**What fails.** CloudFront returns 403 for every request to the Function URL origin. The
function is never invoked: zero entries in the Invocations metric and no CloudWatch log
stream is created.

**What I have ruled out.** I tried six configurations, all with the same result:

1. Production distribution with the managed `AllViewerExceptHostHeader` origin request
   policy
2. The same with a custom origin request policy excluding both `host` and `authorization`
3. The same with origin compression disabled
4. A newly created, separate distribution built for the test
5. That distribution with no origin request policy at all
6. A newly created, separate Lambda function with its own Function URL and its own
   resource policy

**What works,** which is why I do not think this is configuration:

- Calling the same Function URL with a SigV4 signature computed from my own IAM user
  credentials returns 200 and the correct response body.
- `aws lambda invoke` on the same function returns 200.
- An S3 origin on the same distribution, using an Origin Access Control, serves content
  correctly — so OAC itself works in this account.

**The clearest signal.** A Function URL configured with `--auth-type NONE` and a resource
policy of `Principal: "*"`, `Action: lambda:InvokeFunctionUrl`, condition
`lambda:FunctionUrlAuthType = NONE` — the configuration AWS documents for a public
Function URL — also returns 403. That path involves neither CloudFront nor OAC nor any
signature.

So this account appears to permit Function URL invocation by an IAM identity and to
refuse it both for public callers and for the CloudFront service principal.

**A second symptom.** `aws lambda get-account-settings` reports
`ConcurrentExecutions: 10` where the default is 1,000. As a result I also cannot set
reserved concurrency on any function: AWS rejects any reservation that would take
unreserved concurrency below 10, and my total is 10.

    InvalidParameterValueException: Specified ReservedConcurrentExecutions for function
    decreases account's UnreservedConcurrentExecution below its minimum value of [10]

**What I am asking for.** Please review this account for new-account restrictions and
raise the Lambda concurrency limit to the default, and enable Function URL invocation by
the CloudFront service principal and by public callers where the resource policy allows
it.

Happy to provide distribution IDs, function ARNs, or timestamps.
