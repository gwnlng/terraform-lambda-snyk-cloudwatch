.PHONY: install build test plan apply clean

install:
	cd lambda && npm install

build:
	cd lambda && npm run package

test:
	cd lambda && npm run typecheck && npm test

plan: build
	terraform plan -out=tfplan -var snyk_group_id=$(SNYK_GROUP_ID)

apply: plan
	terraform apply tfplan

plan-destroy:
	terraform plan -destroy -out=tfdestroyplan

destroy: plan-destroy
	terraform apply tfdestroyplan

clean:
	cd lambda && npm run clean
	rm -rf builds
