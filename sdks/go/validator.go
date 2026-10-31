package dfsm

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

type SchemaValidator interface {
	Validate(target any, targetDescription string) error
}

type StructTagValidator struct{}

func (v StructTagValidator) Validate(target any, targetDescription string) error {
	if target == nil {
		return nil
	}

	val := reflect.ValueOf(target)
	if val.Kind() == reflect.Pointer {
		if val.IsNil() {
			return nil
		}
		val = val.Elem()
	}

	if val.Kind() != reflect.Struct {
		return nil
	}

	var errs []string
	v.validateStruct(val, "", &errs)

	if len(errs) > 0 {
		return ValidationError{
			Message: fmt.Sprintf("Validation failed for %s", targetDescription),
			Errors:  errs,
		}
	}
	return nil
}

func (v StructTagValidator) validateStruct(val reflect.Value, path string, errs *[]string) {
	typ := val.Type()

	for i := 0; i < val.NumField(); i++ {
		field := typ.Field(i)
		fieldVal := val.Field(i)
		fieldName := field.Name
		currentPath := fieldName
		if path != "" {
			currentPath = path + "." + fieldName
		}

		tag := field.Tag.Get("validate")
		if tag != "" {
			rules := strings.Split(tag, ",")
			for _, rule := range rules {
				rule = strings.TrimSpace(rule)
				switch {
				case rule == "required":
					if fieldVal.IsZero() {
						*errs = append(*errs, fmt.Sprintf("[%s] Field is required", currentPath))
					}
				case rule == "email":
					str := fieldVal.String()
					if str != "" && (!strings.Contains(str, "@") || !strings.Contains(str, ".")) {
						*errs = append(*errs, fmt.Sprintf("[%s] Must be a valid email address", currentPath))
					}
				case strings.HasPrefix(rule, "min="):
					minStr := strings.TrimPrefix(rule, "min=")
					minVal, err := strconv.ParseFloat(minStr, 64)
					if err == nil {
						switch fieldVal.Kind() {
						case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
							if float64(fieldVal.Int()) < minVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Must be at least %s", currentPath, minStr))
							}
						case reflect.Float32, reflect.Float64:
							if fieldVal.Float() < minVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Must be at least %s", currentPath, minStr))
							}
						case reflect.Slice, reflect.Array, reflect.String:
							if float64(fieldVal.Len()) < minVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Minimum length is %s", currentPath, minStr))
							}
						}
					}
				case strings.HasPrefix(rule, "max="):
					maxStr := strings.TrimPrefix(rule, "max=")
					maxVal, err := strconv.ParseFloat(maxStr, 64)
					if err == nil {
						switch fieldVal.Kind() {
						case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
							if float64(fieldVal.Int()) > maxVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Must not exceed %s", currentPath, maxStr))
							}
						case reflect.Float32, reflect.Float64:
							if fieldVal.Float() > maxVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Must not exceed %s", currentPath, maxStr))
							}
						case reflect.Slice, reflect.Array, reflect.String:
							if float64(fieldVal.Len()) > maxVal {
								*errs = append(*errs, fmt.Sprintf("[%s] Maximum length is %s", currentPath, maxStr))
							}
						}
					}
				}
			}
		}

		// Recurse into nested struct or slice of structs
		switch fieldVal.Kind() {
		case reflect.Struct:
			v.validateStruct(fieldVal, currentPath, errs)
		case reflect.Slice, reflect.Array:
			for j := 0; j < fieldVal.Len(); j++ {
				elem := fieldVal.Index(j)
				if elem.Kind() == reflect.Pointer {
					elem = elem.Elem()
				}
				if elem.Kind() == reflect.Struct {
					v.validateStruct(elem, fmt.Sprintf("%s[%d]", currentPath, j), errs)
				}
			}
		case reflect.Pointer:
			if !fieldVal.IsNil() && fieldVal.Elem().Kind() == reflect.Struct {
				v.validateStruct(fieldVal.Elem(), currentPath, errs)
			}
		}
	}
}

