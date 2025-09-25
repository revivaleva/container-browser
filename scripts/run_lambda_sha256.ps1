Param(
  [string]$Bucket = 'container-browser-updates',
  [string]$Key = 'nsis-web/ContainerBrowser-Web-Setup.exe'
)

New-Item -ItemType Directory -Force -Path logs,tmp_lambda | Out-Null

$indexPath = Join-Path (Get-Location) 'tmp_lambda\index.py'
$indexContent = @'
import boto3,hashlib
def handler(event,context):
    s3 = boto3.client('s3')
    bucket = event['bucket']
    key = event['key']
    obj = s3.get_object(Bucket=bucket, Key=key)
    data = obj['Body'].read()
    h = hashlib.sha256(data).hexdigest()
    return {'sha256':h, 'etag': obj.get('ETag'), 'content_length': obj.get('ContentLength')}
'@

Set-Content -Path $indexPath -Value $indexContent -Encoding UTF8

$zipPath = Join-Path (Get-Location) 'lambda_sha256.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path (Get-Location) 'tmp_lambda\*') -DestinationPath $zipPath -Force

$assumePath = Join-Path (Get-Location) 'tmp_assume.json'
$assume = @'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
'@
Set-Content -Path $assumePath -Value $assume -Encoding UTF8

$roleName = 'lambda-s3-sha256-role-' + (Get-Date -UFormat %s)
Write-Host "Creating IAM role: $roleName"
aws iam create-role --role-name $roleName --assume-role-policy-document file://$assumePath > logs/lambda_role_create.json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host 'ROLE_CREATE_FAILED'; Get-Content logs/lambda_role_create.json -Raw | Out-Host; exit 1 }

$roleArn = (Get-Content logs/lambda_role_create.json -Raw | ConvertFrom-Json).Role.Arn
Write-Host "Role ARN: $roleArn"

aws iam attach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole > logs/lambda_role_attach_basic.json 2>&1
aws iam attach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess > logs/lambda_role_attach_s3.json 2>&1

Start-Sleep -Seconds 8

Write-Host 'Creating Lambda function...'
aws lambda create-function --function-name lambda_s3_sha256_temp --runtime python3.11 --role $roleArn --handler index.handler --zip-file fileb://$zipPath --timeout 120 --memory-size 128 > logs/lambda_create.json 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host 'LAMBDA_CREATE_FAILED'; Get-Content logs/lambda_create.json -Raw | Out-Host; goto CLEANUP }

Write-Host 'Invoking Lambda...'
# build JSON payload safely
$payload = @{ bucket = $Bucket; key = $Key } | ConvertTo-Json -Compress
aws lambda invoke --function-name lambda_s3_sha256_temp --payload "$payload" logs/lambda_out.json > logs/lambda_invoke_resp.txt 2>&1
Get-Content logs/lambda_out.json -Raw | Out-File -Encoding utf8 logs/lambda_out_print.json

:CLEANUP
Write-Host 'Cleaning up Lambda and IAM role...'
aws lambda delete-function --function-name lambda_s3_sha256_temp > logs/lambda_delete.json 2>&1
aws iam detach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole > logs/lambda_role_detach_basic.json 2>&1
aws iam detach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess > logs/lambda_role_detach_s3.json 2>&1
aws iam delete-role --role-name $roleName > logs/lambda_role_delete.json 2>&1

Write-Host 'Done. Check logs/lambda_out_print.json for result.'


